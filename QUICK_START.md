# Quick Start Guide - New Improvements

## 🚀 Installation

First, install the required package:

```bash
npm install @nestjs/schedule
```

## ✅ What's New

All improvements from GMB Scheduler have been implemented:

### 1. **Automatic Token Refresh** ✅
- Tokens refresh automatically before expiration
- Retry logic with exponential backoff
- Enhanced error handling

### 2. **Redis Connection Management** ✅
- Connection monitoring with event listeners
- Automatic reconnection
- Health checks

### 3. **Queue Helper Functions** ✅
- Easy queue operations
- Statistics and monitoring
- Job management utilities

### 4. **Token Expiration Tracking** ✅
- Track token expiration
- Find expiring tokens
- Get statistics

### 5. **Job Tracking** ✅
- Track processed jobs in Redis
- Prevent duplicate processing
- Statistics

### 6. **Scheduled Token Refresh** ✅
- Automatic cron job runs every hour
- Proactively refreshes expiring tokens
- Marks invalid accounts as inactive

### 7. **Enhanced Logging** ✅
- Context-aware logging
- Performance tracking
- Structured data logging

## 📝 Usage Examples

### Token Refresh
```typescript
// Automatically refreshes if expired
const tokenRefresh = new TokenRefreshService();
const token = await tokenRefresh.getValidToken(
  'youtube',
  refreshToken,
  accessToken,
  expiresAt
);
```

### Queue Statistics
```typescript
// Get queue stats
const helpers = new QueueHelpers(queue);
const stats = await helpers.getQueueStats();
console.log(stats);
// { waiting: 5, active: 2, completed: 100, failed: 3, delayed: 10 }
```

### Token Expiration Stats
```typescript
// Get expiration statistics
const expirationService = new TokenExpirationService(prisma);
const stats = await expirationService.getExpirationStats();
console.log(stats);
// { expired: 2, expiringIn30Minutes: 5, healthy: 50, total: 57 }
```

## 🔧 Configuration

The cron job runs automatically every hour. To change the schedule, edit:
`src/social-accounts/token-refresh-cron.service.ts`

## 📊 Monitoring

Check logs for:
- `🔄 Starting scheduled token refresh...` - Cron job running
- `✅ Refreshed token for...` - Successful refresh
- `❌ Failed to refresh token...` - Failed refresh

## 🎉 All Set!

Your backend now has all the improvements from GMB Scheduler!
