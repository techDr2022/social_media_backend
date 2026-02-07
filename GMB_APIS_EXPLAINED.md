# Google My Business APIs - Which Ones You Need

Google split GMB functionality into **3 separate APIs**. We use all 3 for different features.

## The 3 APIs We Use

### 1. **My Business Account Management API** ⚠️ REQUIRED FIRST
- **What it does**: Lists your GMB accounts
- **When we call it**: When you connect GMB (to see which accounts you have)
- **Endpoint**: `mybusinessaccountmanagement.googleapis.com/v1/accounts`
- **Enable here**: https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com
- **Status**: ❌ **This is the one causing your 403 error!**

### 2. **My Business Business Information API** (Optional - for locations)
- **What it does**: Gets location details (address, phone, etc.)
- **When we call it**: When you sync locations
- **Endpoint**: `mybusinessbusinessinformation.googleapis.com/v1/accounts/{id}/locations`
- **Enable here**: https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com
- **Status**: Enable after #1 if you want to sync locations

### 3. **Google My Business API** (Optional - for reviews)
- **What it does**: Fetches reviews and lets you reply
- **When we call it**: When syncing reviews or replying to reviews
- **Endpoint**: `mybusiness.googleapis.com/v4/accounts/{id}/locations/{id}/reviews`
- **Enable here**: https://console.cloud.google.com/apis/library/mybusiness.googleapis.com
- **Status**: ✅ You already enabled this one!

## Why Multiple APIs?

Google split GMB into separate APIs for:
- Better organization
- Different permission levels
- Easier to manage access

## What You Need To Do

**Step 1**: Enable **"My Business Account Management API"** (the one you're missing)
- Link: https://console.cloud.google.com/apis/api/mybusinessaccountmanagement.googleapis.com/overview?project=568077365772
- This will fix the 403 error

**Step 2** (Optional): Enable **"My Business Business Information API"** for location syncing
- Link: https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com

**Step 3**: Wait 1-2 minutes, then click **"Sync Locations"** in your app

## Summary

| API Name | Purpose | Required? | Status |
|----------|---------|----------|--------|
| My Business Account Management API | List accounts | ✅ **YES** | ❌ **NOT ENABLED** |
| My Business Business Information API | Locations | Optional | ❓ Not checked |
| Google My Business API | Reviews | Optional | ✅ Enabled |

**Bottom line**: You enabled #3, but we need #1 first to list your accounts!
