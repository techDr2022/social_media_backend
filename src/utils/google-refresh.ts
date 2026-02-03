import axios from 'axios';
import { TokenRefreshService } from './token-refresh.service';

/**
 * Legacy function for backward compatibility
 * @deprecated Use TokenRefreshService instead
 */
export async function refreshGoogleToken(refreshToken: string) {
  // Use the new service for consistency
  const service = new TokenRefreshService();
  const result = await service.refreshGoogleToken(refreshToken);
  
  return {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
  };
}
