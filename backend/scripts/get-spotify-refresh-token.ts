import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:3000/callback';
const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = ['playlist-modify-public'];

const clientId = process.env.SPOTIFY_CLIENT_ID ?? '';
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET ?? '';
const redirectUri = process.env.SPOTIFY_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

if (!clientId || !clientSecret) {
  console.error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET before running this script.');
  process.exit(1);
}

const callbackUrl = new URL(redirectUri);
const state = randomBytes(16).toString('hex');
const authorizeUrl = new URL(SPOTIFY_AUTHORIZE_URL);
authorizeUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  scope: SCOPES.join(' '),
  redirect_uri: redirectUri,
  state,
  show_dialog: 'true',
}).toString();

console.log('Open this URL in a browser and approve the Spotify app once:');
console.log(authorizeUrl.toString());
console.log('');
console.log(`Waiting for Spotify to redirect to ${redirectUri}`);

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? '/', redirectUri);
    if (requestUrl.pathname !== callbackUrl.pathname) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const returnedState = requestUrl.searchParams.get('state');
    const code = requestUrl.searchParams.get('code');
    const error = requestUrl.searchParams.get('error');
    if (error) {
      throw new Error(`Spotify authorization failed: ${error}`);
    }
    if (!code || returnedState !== state) {
      throw new Error('Spotify callback was missing a valid code/state pair.');
    }

    const tokenResponse = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    const body = await tokenResponse.json() as {
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenResponse.ok || !body.refresh_token) {
      throw new Error(
        body.error_description
          ?? body.error
          ?? `Spotify token exchange failed with HTTP ${tokenResponse.status}`,
      );
    }

    console.log('');
    console.log('Add this to backend/.env and your deployment secrets:');
    console.log(`SPOTIFY_REFRESH_TOKEN=${body.refresh_token}`);
    res.statusCode = 200;
    res.end('Spotify refresh token created. You can close this tab and return to the terminal.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    res.statusCode = 500;
    res.end(message);
  } finally {
    server.close();
  }
});

server.listen(Number(callbackUrl.port || 80), callbackUrl.hostname, () => {
  console.log(`Callback server listening on ${redirectUri}`);
});
