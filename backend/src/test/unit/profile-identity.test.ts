import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryQuickNoteStorage, newQuickNoteComment } from '../../services/quick-note-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitService } from '../../services/org-git.js';
import { personDisplayName, personProfileIncomplete } from '../../types/user.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * Who is behind the work (notes #56 and #57): the user's own profile — a
 * required first and last name and a picture — the human named beside every
 * agent's comment, and the workplace's admin-set avatar.
 *
 * The load-bearing assertions: a TEAMMATE's agent's comment names the human
 * who drives it (resolved across the org, or from the stamp the comment now
 * carries, which outlives the agent); the viewer's own agents stay unsigned
 * because they know their own; and the org avatar moves only for admins.
 */

const authHeader = workspaceTestHeaders;

interface MockResponse extends Partial<Response> {
  statusCode: number;
  body: unknown;
}

function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.set = (() => response as Response) as Response['set'];
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  response.type = (() => response as Response) as Response['type'];
  return response;
}

function getRouteHandler(
  deps: Partial<RouteDeps>,
  path: string,
  method: 'get' | 'post' | 'put' | 'delete',
): (req: Partial<Request>, res: MockResponse) => Promise<unknown> {
  const router = workspaceRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }>;
    } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === path && c.route.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

function mockRequest(args: {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
}): Partial<Request> {
  const headers = Object.fromEntries(
    Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    headers,
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {},
    query: {} as Request['query'],
    ...(args.body !== undefined ? { body: args.body } : {}),
  };
}

class FakeMediaStorage {
  objects = new Map<string, { contentType: string; bytes: number }>();
  readAccesses: Array<{ storagePath: string; expiresInMs?: number; responseCacheControl?: string }> = [];
  async uploadObject(args: { storagePath: string; contentType: string; data: Buffer }) {
    this.objects.set(args.storagePath, { contentType: args.contentType, bytes: args.data.length });
  }
  async createReadAccess(args: { storagePath: string; expiresInMs?: number; responseCacheControl?: string }) {
    if (!this.objects.has(args.storagePath)) throw new Error('no such object');
    this.readAccesses.push(args);
    return {
      url: `https://signed.example/${args.storagePath}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }
  async createUploadTarget() { return { uploadUrl: 'unused', expiresAt: 'soon' }; }
  async downloadObject() { return Buffer.alloc(0); }
  async setMetadata() {}
  async deleteObject(args: { storagePath: string }) { this.objects.delete(args.storagePath); }
  async deleteObjectsWithPrefix() {}
}

/**
 * Two humans in one org, an agent each. Owner (42) is the admin viewer;
 * Aisha (43) is the teammate whose agent's remarks must carry her name.
 */
async function build() {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'a@example.com', displayName: 'U1' });
  await userStorage.updateProfile('user-1', {
    person: { firstName: 'Owner', lastName: 'Example' },
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
      agents: {
        'agent-a': {
          id: 'agent-a', name: 'Ben', cli: 'claude', agentbuiltTokenHash: 'x',
          recap: { text: 'Runs the shop site.', at: 't' },
        } as never,
      },
    } as never,
  });
  await userStorage.createProfile('user-2', { email: 'b@example.com', displayName: 'U2' });
  await userStorage.updateProfile('user-2', {
    person: { firstName: 'Aisha', lastName: 'Karimova' },
    telegram: {
      chatId: '2', linkedAt: 't', notificationsEnabled: true, telegramUserId: '43',
      agents: {
        'agent-b': {
          id: 'agent-b', name: 'Ruby', cli: 'claude', agentbuiltTokenHash: 'x',
          // No recap yet, only the retired description. A room now supplies
          // the standing context, so this does not become a recap seed.
          about: 'Research and market analysis',
        } as never,
      },
    } as never,
  });
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
  await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'user-2', role: 'member' });
  const quickNoteStorage = new InMemoryQuickNoteStorage();
  const media = new FakeMediaStorage();
  const deps: Partial<RouteDeps> = {
    userStorage,
    quickNoteStorage,
    orgStorage,
    orgGit: new OrgGitService({ orgStorage }),
    mediaStorage: media as never,
  };
  await addWorkspaceTestAuth(deps, userStorage);
  return { deps, userStorage, orgStorage, quickNoteStorage, media, org };
}

const readNote = async (deps: Partial<RouteDeps>, number: number, viewer: number) => {
  const res = createMockResponse();
  await getRouteHandler(deps, '/api/notes/:number', 'get')(
    mockRequest({ headers: authHeader(viewer), params: { number: String(number) } }), res,
  );
  return (res.body as { note: Record<string, unknown> }).note;
};

describe('who drives the agent (note #57) — comments name the human', () => {
  it('a teammate’s agent’s comment carries the driver’s name, resolved across the org', async () => {
    const { deps, quickNoteStorage, org } = await build();
    const doc = await quickNoteStorage.create({
      userId: org.orgId, html: '<p>Office</p>', createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
    });
    // An OLD comment — no userId stamp — from the teammate's agent.
    await quickNoteStorage.addComment(doc.id, newQuickNoteComment('agent-b', '<p>Closed Mondays.</p>'));

    const note = await readNote(deps, doc.number, 42);
    const comments = note.comments as Array<Record<string, unknown>>;
    expect(comments[0]).toEqual(expect.objectContaining({
      agentName: 'Ruby',
      userName: 'Aisha Karimova',
      // Resolved, not copied from optional overrides: this agent stores no
      // model or effort, but every comment still names what it will run.
      agentRuntime: { cli: 'claude', model: 'opus', effort: 'high' },
    }));
  });

  it('the stamp outlives the agent: a retired agent’s comment still names its human', async () => {
    const { deps, quickNoteStorage, org } = await build();
    const doc = await quickNoteStorage.create({
      userId: org.orgId, html: '<p>Office</p>', createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
    });
    // Stamped at creation, from an agent no fleet holds any more.
    await quickNoteStorage.addComment(doc.id, newQuickNoteComment('agent-gone', '<p>Done.</p>', 'user-2'));

    const note = await readNote(deps, doc.number, 42);
    const comments = note.comments as Array<Record<string, unknown>>;
    expect(comments[0]!.agentName).toBeUndefined();
    expect(comments[0]!.userName).toBe('Aisha Karimova');
    expect(comments[0]!.agentRuntime).toBeUndefined();
  });

  it('the viewer’s OWN agents are signed the same way — one rule for every line', async () => {
    const { deps, quickNoteStorage, org } = await build();
    const doc = await quickNoteStorage.create({
      userId: org.orgId, html: '<p>Office</p>', createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
    });
    await quickNoteStorage.addComment(doc.id, newQuickNoteComment('agent-a', '<p>On it.</p>', 'user-1'));

    const note = await readNote(deps, doc.number, 42);
    const comments = note.comments as Array<Record<string, unknown>>;
    expect(comments[0]!.agentName).toBe('Ben');
    expect(comments[0]!.userName).toBe('Owner Example');
    // And the note's own author line, which that same viewer wrote via Ben.
    expect(note.userName).toBe('Owner Example');
  });

  it('a teammate’s agent’s NOTE is signed, and its face opens that agent', async () => {
    const { deps, quickNoteStorage, org } = await build();
    const doc = await quickNoteStorage.create({
      userId: org.orgId, html: '<p>Menu</p>', createdByAgentId: 'agent-b', updatedByAgentId: 'agent-b',
    });

    const note = await readNote(deps, doc.number, 42);
    expect(note.agentName).toBe('Ruby');
    expect(note.userName).toBe('Aisha Karimova');
    // The door used to be viewer-only, because a teammate's agent had no
    // screen to land on. It has one since note #640 — read-only, its owner's
    // controls nowhere on it — so every face in the workplace is a door.
    expect(note.agentId).toBe('agent-b');
  });

  it('a teammate’s own jotting wears their name, not “another member”', async () => {
    const { deps, quickNoteStorage, org } = await build();
    const doc = await quickNoteStorage.create({
      userId: org.orgId, html: '<p>Wifi is 4417</p>',
      createdByAgentId: 'user', updatedByAgentId: 'user', updatedByUserId: 'user-2',
    });

    const note = await readNote(deps, doc.number, 42);
    expect(note.byMember).toBe(true);
    expect(note.memberName).toBe('Aisha Karimova');
  });
});

describe('faces as doors (notes #58, #60, #61)', () => {
  it('a comment carries the agent id for every agent the workplace still has (note #640)', async () => {
    const { deps, quickNoteStorage, org } = await build();
    const doc = await quickNoteStorage.create({
      userId: org.orgId, html: '<p>Office</p>', createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
    });
    await quickNoteStorage.addComment(doc.id, newQuickNoteComment('agent-a', '<p>On it.</p>', 'user-1'));
    await quickNoteStorage.addComment(doc.id, newQuickNoteComment('agent-b', '<p>Noted.</p>', 'user-2'));
    await quickNoteStorage.addComment(doc.id, newQuickNoteComment('agent-gone', '<p>Filed.</p>', 'user-2'));

    // Both remarks are doors, and the SAME doors from either end of the
    // thread: the reader's own agent opens its control room, a teammate's
    // its read-only page. It used to swap sides with whoever was reading.
    const mine = (await readNote(deps, doc.number, 42)).comments as Array<Record<string, unknown>>;
    expect(mine[0]!.agentId).toBe('agent-a');
    expect(mine[1]!.agentId).toBe('agent-b');
    const theirs = (await readNote(deps, doc.number, 43)).comments as Array<Record<string, unknown>>;
    expect(theirs[0]!.agentId).toBe('agent-a');
    expect(theirs[1]!.agentId).toBe('agent-b');
    // An agent the workplace no longer has is the one face with no door: the
    // remark stands, there is simply nothing to open.
    expect(mine[2]!.agentId).toBeUndefined();
    expect(theirs[2]!.agentId).toBeUndefined();
  });

  it('a human-written note names its author for everyone, the writer included', async () => {
    const { deps, quickNoteStorage, org } = await build();
    const doc = await quickNoteStorage.create({
      userId: org.orgId, html: '<p>Wifi is 4417</p>',
      createdByAgentId: 'user', updatedByAgentId: 'user',
      createdByUserId: 'user-1', updatedByUserId: 'user-1',
    });

    // The writer's own view signs with the NAME (note #60) — the row shows
    // the face and name, never "you wrote this".
    const own = await readNote(deps, doc.number, 42);
    expect(own.byUser).toBe(true);
    expect(own.authorName).toBe('Owner Example');
    expect(own.authorUserId).toBe('user-1');
    // And the teammate's view names the same human, id included, so the face
    // can be a door to their member page (note #61).
    const theirs = await readNote(deps, doc.number, 43);
    expect(theirs.byMember).toBe(true);
    expect(theirs.authorName).toBe('Owner Example');
    expect(theirs.authorUserId).toBe('user-1');
  });

  it('an agent’s note carries no author pair — its own agent line already signs it', async () => {
    const { deps, quickNoteStorage, org } = await build();
    const doc = await quickNoteStorage.create({
      userId: org.orgId, html: '<p>Menu</p>', createdByAgentId: 'agent-b', updatedByAgentId: 'agent-b',
    });
    const note = await readNote(deps, doc.number, 42);
    expect(note.authorName).toBeUndefined();
    expect(note.authorUserId).toBeUndefined();
  });

  it('the org’s members list names each member’s agents and what each is doing (2026-10-28)', async () => {
    const { deps } = await build();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const members = (res.body as { org: { members: Array<Record<string, unknown>> } }).org.members;
    const byId = new Map(members.map((m) => [m.userId, m]));
    // How many (note #346), and — since the owner's rule of 2026-09-23 that
    // a person's agents are never hidden from the rest of the workplace —
    // which: each one's name and face.
    expect(byId.get('user-1')!.agents).toBe(1);
    expect(byId.get('user-2')!.agents).toBe(1);
    expect(byId.get('user-1')!.agentFaces).toEqual([expect.objectContaining({ id: 'agent-a', name: 'Ben' })]);
    expect(byId.get('user-2')!.agentFaces).toEqual([expect.objectContaining({ id: 'agent-b', name: 'Ruby' })]);
    // And since Adam's ask of 2026-10-28 ("what their agents cooking"),
    // reversing note #346: each agent's latest-work line rides with it —
    // the recap its own row carries, and nothing of its chat.
    expect(byId.get('user-1')!.agentFaces).toEqual([expect.objectContaining({ id: 'agent-a', recap: 'Runs the shop site.' })]);
  });
});

describe('the profile (note #57) — a required name, and a picture', () => {
  it('saves both names and starts naming the human by them', async () => {
    const { deps, userStorage } = await build();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/profile', 'post')(
      mockRequest({ headers: authHeader(42), body: { firstName: '  Owner ', lastName: 'B.' } }), res,
    );
    expect(res.statusCode).toBe(200);
    const profile = await userStorage.getProfile('user-1');
    expect(profile?.person).toEqual(expect.objectContaining({ firstName: 'Owner', lastName: 'B.' }));
    expect(personDisplayName(profile)).toBe('Owner B.');
  });

  it('refuses a missing half — both names are the point', async () => {
    const { deps } = await build();
    for (const body of [{ firstName: 'Owner' }, { lastName: 'B' }, { firstName: ' ', lastName: 'B' }, {}]) {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/profile', 'post')(
        mockRequest({ headers: authHeader(42), body }), res,
      );
      expect(res.statusCode).toBe(400);
    }
  });

  it('a picture lands in media storage and comes back signed; replacing deletes the old bytes', async () => {
    const { deps, media, userStorage } = await build();
    const upload = (bytes: Buffer, type = 'image/jpeg') => {
      const res = createMockResponse();
      return getRouteHandler(deps, '/api/profile/photo', 'post')(
        { ...mockRequest({ headers: { ...authHeader(42), 'content-type': type } }), body: bytes } as Partial<Request>,
        res,
      ).then(() => res);
    };
    const first = await upload(Buffer.from('img-one'));
    expect(first.statusCode).toBe(200);
    expect((first.body as { photoUrl: string }).photoUrl).toContain('https://signed.example/users/user-1/profile/');
    const firstPath = (await userStorage.getProfile('user-1'))!.person!.photo!.storagePath;
    expect(media.objects.has(firstPath)).toBe(true);

    const second = await upload(Buffer.from('img-two'));
    expect(second.statusCode).toBe(200);
    const secondPath = (await userStorage.getProfile('user-1'))!.person!.photo!.storagePath;
    expect(secondPath).not.toBe(firstPath);
    expect(media.objects.has(firstPath)).toBe(false);
    expect(media.objects.has(secondPath)).toBe(true);
  });

  it('refuses what is not an image, and what is too big', async () => {
    const { deps } = await build();
    const attempt = async (bytes: Buffer, type: string) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/profile/photo', 'post')(
        { ...mockRequest({ headers: { ...authHeader(42), 'content-type': type } }), body: bytes } as Partial<Request>,
        res,
      );
      return res;
    };
    expect((await attempt(Buffer.from('x'), 'application/pdf')).statusCode).toBe(400);
    expect((await attempt(Buffer.alloc(0), 'image/png')).statusCode).toBe(400);
    expect((await attempt(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png')).statusCode).toBe(400);
  });

  // Note #189 took the one-tap Telegram import out: a picture is chosen, and
  // the only door to a photo is the upload above. Asserted as an absence so
  // the route cannot come back without this line coming with it — the stored
  // `source: 'telegram'` stays a legal value, because accounts that used the
  // old flow still carry it.
  it('has no Telegram-photo import route', async () => {
    const { deps } = await build();
    expect(() => getRouteHandler(deps, '/api/profile/photo/telegram', 'post')).toThrow();
  });

  it('completeness needs both names and the picture', () => {
    expect(personProfileIncomplete({
      person: {
        firstName: 'Owner', lastName: 'Example',
        photo: { storagePath: 'p', contentType: 'image/jpeg', sizeBytes: 1, updatedAt: 't', source: 'upload' },
      },
    } as never)).toBe(false);
    expect(personProfileIncomplete({ person: { firstName: 'Owner' } } as never)).toBe(true);
    expect(personProfileIncomplete({
      person: { firstName: 'Owner', lastName: 'Example' },
    } as never)).toBe(true);
    // A name left on the old Telegram link is not a profile name.
    expect(personProfileIncomplete({
      telegram: { firstName: 'Owner', lastName: 'Example' },
      person: { photo: { storagePath: 'p', contentType: 'image/jpeg', sizeBytes: 1, updatedAt: 't', source: 'upload' } },
    } as never)).toBe(true);
  });
});

describe('the workplace avatar (note #56) — an admin fact', () => {
  const setAvatar = (deps: Partial<RouteDeps>, viewer: number, bytes = Buffer.from('org-logo')) => {
    const res = createMockResponse();
    return getRouteHandler(deps, '/api/org/avatar', 'post')(
      { ...mockRequest({ headers: { ...authHeader(viewer), 'content-type': 'image/png' } }), body: bytes } as Partial<Request>,
      res,
    ).then(() => res);
  };

  it('an admin sets it; the org record points at it and every payload wears it signed', async () => {
    const { deps, orgStorage, org } = await build();
    const res = await setAvatar(deps, 42);
    expect(res.statusCode).toBe(200);
    const stored = (await orgStorage.getOrg(org.orgId))!.avatar!;
    expect(stored.storagePath).toContain(`users/${org.orgId}/org/`);
    expect(stored.setByUserId).toBe('user-1');

    const detail = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(43) }), detail);
    expect((detail.body as { org: { avatarUrl: string } }).org.avatarUrl)
      .toBe(`https://signed.example/${stored.storagePath}`);
  });

  it('a member may not set or remove it', async () => {
    const { deps } = await build();
    expect((await setAvatar(deps, 43)).statusCode).toBe(403);
    const remove = createMockResponse();
    await getRouteHandler(deps, '/api/org/avatar', 'delete')(
      mockRequest({ headers: authHeader(43) }), remove,
    );
    expect(remove.statusCode).toBe(403);
  });

  it('replacing deletes the old bytes; removing deletes pointer and bytes', async () => {
    const { deps, media, orgStorage, org } = await build();
    await setAvatar(deps, 42, Buffer.from('one'));
    const firstPath = (await orgStorage.getOrg(org.orgId))!.avatar!.storagePath;
    await setAvatar(deps, 42, Buffer.from('two'));
    expect(media.objects.has(firstPath)).toBe(false);
    const secondPath = (await orgStorage.getOrg(org.orgId))!.avatar!.storagePath;
    expect(media.objects.has(secondPath)).toBe(true);

    const remove = createMockResponse();
    await getRouteHandler(deps, '/api/org/avatar', 'delete')(
      mockRequest({ headers: authHeader(42) }), remove,
    );
    expect(remove.statusCode).toBe(200);
    expect((await orgStorage.getOrg(org.orgId))!.avatar).toBeUndefined();
    expect(media.objects.has(secondPath)).toBe(false);
  });
});

describe('the state payload — who is looking, and the org’s face', () => {
  it('carries the viewer’s profile block and the org avatar', async () => {
    const { deps, userStorage, orgStorage, org } = await build();
    await userStorage.updatePersonFields('user-1', {
      firstName: 'Owner', lastName: 'B.',
      photo: { storagePath: 'users/user-1/profile/p1', contentType: 'image/jpeg', sizeBytes: 3, updatedAt: 't', source: 'upload' },
    });
    await (deps.mediaStorage as unknown as FakeMediaStorage).uploadObject({
      storagePath: 'users/user-1/profile/p1', contentType: 'image/jpeg', data: Buffer.from('img'),
    });
    await orgStorage.updateOrg(org.orgId, {
      avatar: { storagePath: `users/${org.orgId}/org/a1`, contentType: 'image/png', sizeBytes: 3, updatedAt: 't', setByUserId: 'user-1' },
    });
    await (deps.mediaStorage as unknown as FakeMediaStorage).uploadObject({
      storagePath: `users/${org.orgId}/org/a1`, contentType: 'image/png', data: Buffer.from('img'),
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      user: { name: string; profile: { firstName: string; lastName: string; photoUrl?: string; incomplete: boolean } };
      org: { avatarUrl?: string };
    };
    expect(body.user.name).toBe('Owner B.');
    expect(body.user.profile).toEqual(expect.objectContaining({
      firstName: 'Owner', lastName: 'B.', incomplete: false,
      photoUrl: 'https://signed.example/users/user-1/profile/p1',
    }));
    expect(body.org.avatarUrl).toBe(`https://signed.example/users/${org.orgId}/org/a1`);
  });

  it('nudges until the profile is complete', async () => {
    const { deps } = await build();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const body = res.body as { user: { profile: { incomplete: boolean } } };
    // Both names are there, but there is no picture yet.
    expect(body.user.profile.incomplete).toBe(true);
  });

  it('keeps picture URLs stable across state polls so the browser can reuse cached bytes', async () => {
    const { deps, media, userStorage, orgStorage, org } = await build();
    const profilePath = 'users/user-1/profile/p1';
    const orgPath = `users/${org.orgId}/org/a1`;
    await userStorage.updatePersonFields('user-1', {
      firstName: 'Owner', lastName: 'B.',
      photo: { storagePath: profilePath, contentType: 'image/jpeg', sizeBytes: 3, updatedAt: 't', source: 'upload' },
    });
    await media.uploadObject({ storagePath: profilePath, contentType: 'image/jpeg', data: Buffer.from('img') });
    await orgStorage.updateOrg(org.orgId, {
      avatar: { storagePath: orgPath, contentType: 'image/png', sizeBytes: 3, updatedAt: 't', setByUserId: 'user-1' },
    });
    await media.uploadObject({ storagePath: orgPath, contentType: 'image/png', data: Buffer.from('img') });

    let signature = 0;
    media.createReadAccess = async (args: { storagePath: string; expiresInMs?: number; responseCacheControl?: string }) => {
      media.readAccesses.push(args);
      return {
        url: `https://signed.example/${args.storagePath}?signature=${++signature}`,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
    };
    const handler = getRouteHandler(deps, '/api/state', 'get');
    const read = async () => {
      const res = createMockResponse();
      await handler(mockRequest({ headers: authHeader(42) }), res);
      return res.body as {
        user: { profile: { photoUrl: string } };
        org: { avatarUrl: string };
      };
    };

    const first = await read();
    const second = await read();
    expect(second.user.profile.photoUrl).toBe(first.user.profile.photoUrl);
    expect(second.org.avatarUrl).toBe(first.org.avatarUrl);
    expect(media.readAccesses).toEqual([
      { storagePath: profilePath, expiresInMs: 15 * 60_000, responseCacheControl: 'private, max-age=840, immutable' },
      { storagePath: orgPath, expiresInMs: 15 * 60_000, responseCacheControl: 'private, max-age=840, immutable' },
    ]);
    expect(media.readAccesses.filter((call) => call.storagePath === profilePath)).toHaveLength(1);
    expect(media.readAccesses.filter((call) => call.storagePath === orgPath)).toHaveLength(1);

    // Replacing a picture mints a new UUID path, so it never inherits the old
    // bytes merely because that old path still has a live cache entry.
    const replacementPath = 'users/user-1/profile/p2';
    await userStorage.updatePersonFields('user-1', {
      photo: { storagePath: replacementPath, contentType: 'image/jpeg', sizeBytes: 3, updatedAt: 't2', source: 'upload' },
    });
    await media.uploadObject({ storagePath: replacementPath, contentType: 'image/jpeg', data: Buffer.from('new') });
    const replaced = await read();
    expect(replaced.user.profile.photoUrl).toContain(replacementPath);
    expect(replaced.user.profile.photoUrl).not.toBe(first.user.profile.photoUrl);
  });
});
