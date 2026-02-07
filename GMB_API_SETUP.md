# Google My Business (GMB) – Fix 403 / Access Denied

If you see **403** when connecting GMB, the right APIs are not enabled or the wrong one was enabled.

## Enable the correct API

The endpoint we call is **My Business Account Management API**, not "Google My Business API".

1. Open this link **in your Google Cloud project**:
   - **https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com**

2. Select the same project you use for OAuth (scheduler / frontend).

3. Click **Enable**.

4. Wait 1–2 minutes, then in your app click **Sync Locations** on the GMB account (or reconnect GMB).

## Optional: enable related APIs (for locations and reviews)

For full GMB features (locations, reviews), also enable:

- **My Business Business Information API**  
  https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com

- **Google My Business API** (for reviews)  
  https://console.cloud.google.com/apis/library/mybusiness.googleapis.com

## If it still returns 403

1. Confirm you’re in the **same project** as your OAuth client (Credentials → your OAuth 2.0 Client ID).
2. Check the backend logs: we now log the exact error from Google (e.g. `Access Not Configured` vs `Permission Denied`).
3. **Access Not Configured** → API not enabled or wrong project.
4. **Permission Denied** → OAuth scopes or consent; ensure `https://www.googleapis.com/auth/business.manage` is requested and the user has accepted it.

## Quick link summary

| API name | Purpose | Link |
|----------|--------|------|
| My Business Account Management API | List GMB accounts (required for connect) | [Enable](https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com) |
| My Business Business Information API | Locations | [Enable](https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com) |
| Google My Business API | Reviews | [Enable](https://console.cloud.google.com/apis/library/mybusiness.googleapis.com) |
