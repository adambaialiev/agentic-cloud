import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App.js';
import { WorkspaceApiError } from '../../api/client.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * Choosing a profile picture opens a framing step (note #660): the picture
 * under a fixed circle, dragged and zoomed into place, and only the square
 * behind the circle goes up. jsdom decodes no images and draws nothing, so
 * the picture's size is handed to it and the canvas is a recorder.
 */

const state = () => emptyState({
  org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] },
  user: { name: 'Saddam B', profile: { firstName: 'Saddam', lastName: 'B', incomplete: false }, account: { browserLogin: { enabled: true, method: 'totp', username: 'saddam' } } },
});

function renderProfile(script: Record<string, Answer> = {}) {
  const scripted = scriptedApi({ ...workspaceScript(state), 'GET api/org/signin': () => ({ signin: null }), ...script });
  render(<MemoryRouter initialEntries={['/profile']}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

/** A canvas that records the cut and hands back a blob of the asked type. */
function recordCanvas() {
  const drawImage = vi.fn();
  const blobs: { width: number; height: number; blob: Blob }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(this: HTMLCanvasElement, done: BlobCallback, type?: string) {
    const blob = new Blob(['cut'], { type: type ?? 'image/png' });
    blobs.push({ width: this.width, height: this.height, blob });
    done(blob);
  });
  return Object.assign(drawImage, { blobs });
}

function objectUrls() {
  const revoke = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:chosen'), revokeObjectURL: revoke }));
  return revoke;
}

async function choose(file = new File(['jpeg'], 'me.jpg', { type: 'image/jpeg' }), size = { width: 400, height: 200 }) {
  await screen.findByRole('button', { name: 'Choose a picture' });
  fireEvent.change(document.getElementById('profilePhotoInput')!, { target: { files: [file] } });
  expect(await screen.findByRole('heading', { name: 'Position your picture' })).toBeTruthy();
  const stage = document.getElementById('pictureFrameStage')!;
  // The stage's box: 300px square on screen, so the circle is 240px.
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300, right: 300, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
  stage.setPointerCapture = vi.fn();
  const image = stage.querySelector('img')!;
  expect((screen.getByRole('button', { name: 'Use this picture' }) as HTMLButtonElement).disabled).toBe(true);
  Object.defineProperty(image, 'naturalWidth', { value: size.width, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: size.height, configurable: true });
  fireEvent.load(image);
  return { stage, image };
}

describe('framing a new profile picture', () => {
  it('puts the chosen picture under the circle and uploads only the square the reader dragged into it', async () => {
    const revoke = objectUrls();
    const drawImage = recordCanvas();
    const { calls } = renderProfile({ 'POST api/profile/photo': () => ({ ok: true, photoUrl: '/p/me.jpg' }) });
    const { stage, image } = await choose();

    // Nothing goes up on choosing.
    expect(calls.some((call) => call.path === 'api/profile/photo')).toBe(false);
    // A 2:1 picture at Fit: as tall as the circle, twice as wide, centred.
    expect(image.style.left).toBe('-30%');
    expect(image.style.width).toBe('160%');

    // Dragged 60px right: a quarter of the 240px circle.
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 160, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    // The drag that ended there is not the backdrop's "no".
    fireEvent.click(document.querySelector('.scrim')!);
    expect(screen.getByRole('heading', { name: 'Position your picture' })).toBeTruthy();
    expect(image.style.left).toBe('-10%');

    fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/profile/photo')).toBe(true));
    // The circle held the picture 50px left of its middle: x 50, not 100.
    expect(drawImage).toHaveBeenCalledWith(image, 50, 0, 200, 200, 0, 0, 200, 200);
    const upload = calls.find((call) => call.path === 'api/profile/photo')!;
    expect(new Headers(upload.init?.headers).get('content-type')).toBe('image/jpeg');
    // …and what goes up is that square, at its own 200px.
    expect(drawImage.blobs).toHaveLength(1);
    expect(drawImage.blobs[0]).toMatchObject({ width: 200, height: 200 });
    expect(upload.init?.body).toBe(drawImage.blobs[0]!.blob);
    expect(await screen.findByText('That’s you now.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Position your picture' })).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:chosen');
  });

  it('zooms with the slider, and with two fingers on a phone', async () => {
    objectUrls();
    const drawImage = recordCanvas();
    const { calls } = renderProfile({ 'POST api/profile/photo': () => ({ ok: true }) });
    const { stage, image } = await choose(new File(['png'], 'me.png', { type: 'image/png' }), { width: 1000, height: 1000 });

    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '2' } });
    expect(image.style.width).toBe('160%');

    // Fingers 100px apart spread to 150px about the stage's centre: 1.5x more.
    const finger = (clientX: number) => ({ identifier: clientX, clientX, clientY: 150 });
    fireEvent.touchStart(stage, { touches: [finger(100), finger(200)] });
    fireEvent.touchMove(stage, { touches: [finger(75), finger(225)] });
    fireEvent.touchEnd(stage, { touches: [] });
    expect((screen.getByRole('slider', { name: 'Zoom' }) as HTMLInputElement).value).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/profile/photo')).toBe(true));
    // A third of the picture, from its middle, as a PNG.
    const [, x, y, side] = drawImage.mock.calls[0]!;
    expect(x).toBeCloseTo(333.33, 1);
    expect(y).toBeCloseTo(333.33, 1);
    expect(side).toBeCloseTo(333.33, 1);
    const upload = calls.find((call) => call.path === 'api/profile/photo')!;
    expect(new Headers(upload.init?.headers).get('content-type')).toBe('image/png');
  });

  it('keeps the frame open with the reason when the upload is refused, and Cancel sends nothing', async () => {
    const revoke = objectUrls();
    recordCanvas();
    const { calls } = renderProfile({
      'POST api/profile/photo': () => { throw new WorkspaceApiError('A picture here is a JPEG, PNG or WebP image.', 400, {}); },
    });
    await choose();

    fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
    expect(await screen.findByText('A picture here is a JPEG, PNG or WebP image.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Position your picture' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Use this picture' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Position your picture' })).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:chosen');
    expect(calls.filter((call) => call.path === 'api/profile/photo')).toHaveLength(1);
  });

  it('says so when the file will not open as a picture, and refuses one past 20 MB', async () => {
    objectUrls();
    renderProfile();
    await screen.findByRole('button', { name: 'Choose a picture' });
    fireEvent.change(document.getElementById('profilePhotoInput')!, { target: { files: [new File(['x'], 'me.jpg', { type: 'image/jpeg' })] } });
    fireEvent.error((await screen.findByRole('group', { name: /Your picture/ })).querySelector('img')!);
    expect(await screen.findByText('That file would not open as a picture — try a JPEG, PNG or WebP.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Position your picture' })).toBeNull();

    const huge = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(huge, 'size', { value: 21 * 1024 * 1024 });
    fireEvent.change(document.getElementById('profilePhotoInput')!, { target: { files: [huge] } });
    expect(await screen.findByText('A picture here is up to 20 MB.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Position your picture' })).toBeNull();
  });
});
