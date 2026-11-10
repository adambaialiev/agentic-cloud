import type { Request, Response, Router } from 'express';
import type { RouteDeps } from './deps.js';
import { VoiceSettingsError } from '../services/workplace-voice.js';
import { personDisplayName } from '../types/user.js';
import { DEFAULT_VOICE_MODEL, voiceModelInfo, type VoiceAnswer, type VoiceModelsAnswer } from '../shared/voice.js';

/** Who is asking, as the Workspace's own session resolved it. */
export interface VoiceReader {
  userId: string;
  /** Null for an account in no workplace: its voice-to-text is simply off. */
  orgId: string | null;
  admin: boolean;
}

type WorkplaceReader = VoiceReader & { orgId: string };

/**
 * A workplace's voice-to-text settings (note #1026). Reading is every
 * member's: the recorder needs on / off / paused before anyone talks, and a
 * member is told who can fix it. Saving or removing the key and choosing the
 * model are an ADMIN's, in their own browser session only: these routes sit
 * on the Workspace router, and the agents' router has no verb that reaches
 * them (Adam, #1026 point 7).
 */
export function registerVoiceRoutes(router: Router, deps: RouteDeps,
  reader: (req: Request, res: Response) => Promise<VoiceReader | null>) {
  const service = () => deps.workplaceVoice;

  const unavailable = (res: Response) =>
    res.status(503).json({ error: 'Voice-to-text settings are not available on this backend.' });

  const adminNames = async (orgId: string): Promise<string[]> => {
    const members = await deps.orgStorage?.listMembers(orgId).catch(() => []) ?? [];
    const names = await Promise.all(members
      .filter((member) => member.role === 'admin')
      .map(async (member) => personDisplayName(await deps.userStorage?.getProfile(member.userId).catch(() => null))));
    return names.sort((a, b) => a.localeCompare(b));
  };

  /** The other workplaces this person is ALSO an admin of (note #1116). */
  const alsoAdminOf = async (who: WorkplaceReader): Promise<string[]> => {
    if (!who.admin) return [];
    const memberships = await deps.orgStorage?.listMembershipsByUser(who.userId).catch(() => []) ?? [];
    return memberships.filter((m) => m.role === 'admin' && m.orgId !== who.orgId).map((m) => m.orgId);
  };

  const answer = async (who: WorkplaceReader): Promise<VoiceAnswer> =>
    service()!.answer(who.orgId, { admin: who.admin, admins: await adminNames(who.orgId), alsoAdminOf: await alsoAdminOf(who) });

  const fail = (res: Response, error: unknown, what: string) => {
    if (error instanceof VoiceSettingsError) {
      return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    console.warn(`[voice-transcription] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    return res.status(500).json({ error: 'That could not be saved. Try again.' });
  };

  /** An admin of the workplace being viewed, or null once refused. */
  const admin = async (req: Request, res: Response): Promise<WorkplaceReader | null> => {
    const who = await reader(req, res);
    if (!who) return null;
    if (!service()) { unavailable(res); return null; }
    if (!who.orgId) {
      res.status(403).json({ error: 'Voice-to-text belongs to a workplace; this account is not in one yet.' });
      return null;
    }
    if (!who.admin) {
      res.status(403).json({ error: 'Only an admin of this workplace can change voice-to-text.' });
      return null;
    }
    return { ...who, orgId: who.orgId };
  };

  const nameOf = async (userId: string) =>
    personDisplayName(await deps.userStorage?.getProfile(userId).catch(() => null));

  router.get('/api/voice', async (req, res) => {
    const who = await reader(req, res);
    if (!who) return;
    // No voice service on this backend, or no workplace (so no key to pay
    // with): off, and nobody here can change that. Every microphone reads
    // this before recording, so "off" is an answer, not an error.
    if (!service() || !who.orgId) {
      return res.json({
        state: 'off',
        model: { id: DEFAULT_VOICE_MODEL, name: voiceModelInfo(DEFAULT_VOICE_MODEL)?.name ?? DEFAULT_VOICE_MODEL },
        admins: [],
        canChange: false,
      } satisfies VoiceAnswer);
    }
    try {
      return res.json(await answer({ ...who, orgId: who.orgId }));
    } catch (error) {
      return fail(res, error, 'reading the settings');
    }
  });

  router.get('/api/voice/models', async (req, res) => {
    const who = await reader(req, res);
    if (!who) return;
    if (!service()) return unavailable(res);
    return res.json(await service()!.models() satisfies VoiceModelsAnswer);
  });

  router.put('/api/voice/key', async (req, res) => {
    const who = await admin(req, res);
    if (!who) return;
    try {
      await service()!.saveKey(who.orgId, (req.body as { key?: unknown } | undefined)?.key, await nameOf(who.userId));
      console.log(`[voice-transcription] ${who.orgId}: an admin saved the workplace's OpenRouter key`);
      return res.json(await answer(who));
    } catch (error) {
      return fail(res, error, 'saving the key');
    }
  });

  // Copy the key another workplace already holds (note #1116, Adam: "if I
  // am admin for both of course"). An admin HERE, and an admin THERE by the
  // membership row, not by anything the browser says. The value is read and
  // re-stored on the server; the answer carries names only.
  router.post('/api/voice/key/copy', async (req, res) => {
    const who = await admin(req, res);
    if (!who) return;
    const fromOrgId = (req.body as { fromOrgId?: unknown } | undefined)?.fromOrgId;
    if (typeof fromOrgId !== 'string' || !fromOrgId.trim() || fromOrgId === who.orgId) {
      return res.status(400).json({ error: 'Choose another workplace to copy the key from.' });
    }
    const there = await deps.orgStorage?.getMembership(fromOrgId, who.userId).catch(() => null) ?? null;
    if (there?.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin of both workplaces can copy the key.' });
    }
    try {
      await service()!.copyKey(who.orgId, fromOrgId, await nameOf(who.userId));
      console.log(`[voice-transcription] ${who.orgId}: an admin copied the OpenRouter key from workplace ${fromOrgId}`);
      return res.json(await answer(who));
    } catch (error) {
      return fail(res, error, 'copying the key');
    }
  });

  router.delete('/api/voice/key', async (req, res) => {
    const who = await admin(req, res);
    if (!who) return;
    try {
      await service()!.removeKey(who.orgId);
      console.log(`[voice-transcription] ${who.orgId}: an admin removed the workplace's OpenRouter key`);
      return res.json(await answer(who));
    } catch (error) {
      return fail(res, error, 'removing the key');
    }
  });

  router.put('/api/voice/model', async (req, res) => {
    const who = await admin(req, res);
    if (!who) return;
    try {
      await service()!.setModel(who.orgId, (req.body as { model?: unknown } | undefined)?.model, await nameOf(who.userId));
      return res.json(await answer(who));
    } catch (error) {
      return fail(res, error, 'choosing the model');
    }
  });
}
