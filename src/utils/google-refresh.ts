import axios from 'axios';

export async function refreshGoogleToken(refreshToken: string) {
  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    {
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  return {
    accessToken: res.data.access_token,
    expiresIn: res.data.expires_in,
  };
}
