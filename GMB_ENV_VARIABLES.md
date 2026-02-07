# GMB Environment Variables - What We're Using

## Backend (`ba/.env`)

### Required for GMB OAuth:
```env
# Google OAuth Credentials (shared with YouTube)
GOOGLE_OAUTH_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-google-oauth-client-secret

# GMB-specific redirect URI
GOOGLE_OAUTH_REDIRECT_URI_GMB=http://localhost:3001/social-accounts/callback/gmb

# Fallback (used if GMB redirect not set)
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3001/social-accounts/callback/youtube

# Frontend URL (for redirects after OAuth)
FRONTEND_URL=social-media-frontend-sooty.vercel.app
```

### Database (for storing GMB data):
```env
DATABASE_URL="postgresql://postgres.username:your-password@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.username:your-password@aws-1-ap-south-1.pooler.supabase.com:5432/postgres"
```

## Frontend (`f/.env`)

```env
# Backend API URL (for proxying requests)
NEXT_PUBLIC_API_URL=http://localhost:3000

# Supabase (for auth)
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
```

## How GMB Uses These Variables

### 1. **OAuth Flow** (when connecting GMB):
- Uses: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- Redirect URI: `GOOGLE_OAUTH_REDIRECT_URI_GMB` (or fallback from YouTube URI)
- After OAuth: Redirects to `FRONTEND_URL/gmb`

### 2. **Token Storage**:
- Stores encrypted tokens in database (via `DATABASE_URL`)
- Uses same Google OAuth credentials as YouTube

### 3. **API Calls**:
- No additional API keys needed
- Uses OAuth tokens stored in database
- Calls Google APIs directly:
  - `mybusinessaccountmanagement.googleapis.com` (accounts)
  - `mybusinessbusinessinformation.googleapis.com` (locations)
  - `mybusiness.googleapis.com` (reviews)

## Summary

**GMB uses the SAME Google OAuth credentials as YouTube** - no separate API keys needed!

The only GMB-specific env var is:
- `GOOGLE_OAUTH_REDIRECT_URI_GMB` (for the callback URL)

Everything else is shared with YouTube OAuth.
