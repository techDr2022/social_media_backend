import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Media Handler
 * 
 * Handles large media files (10MB-100MB+):
 * - Verifies Supabase Storage URLs are accessible
 * - Prepares files for platform APIs
 * - Future: Supports S3 bucket
 */
@Injectable()
export class MediaHandler {
  private readonly logger = new Logger(MediaHandler.name);

  /**
   * Prepare media for publishing
   * 
   * If media is a public URL (Supabase/S3), use it directly.
   * If media is local file, ensure it's accessible.
   */
  async prepareMediaForPublishing(
    mediaUrl: string,
    platform: string,
    postId: string,
  ): Promise<string> {
    // If it's already a public URL, verify it's accessible
    if (this.isPublicUrl(mediaUrl)) {
      this.logger.log(`Verifying public URL: ${mediaUrl}`);
      
      // Verify URL is accessible (for Supabase Storage)
      if (this.isSupabaseUrl(mediaUrl)) {
        try {
          const response = await axios.head(mediaUrl, {
            timeout: 5000,
            validateStatus: (status) => status < 500,
          });

          if (response.status === 200) {
            this.logger.log(`Supabase URL is accessible: ${mediaUrl}`);
            return mediaUrl;
          } else {
            throw new Error(`Media URL not accessible: ${response.status}`);
          }
        } catch (error: any) {
          this.logger.error(`Failed to verify media URL: ${error.message}`);
          throw new Error(`Media URL not accessible: ${error.message}`);
        }
      }
      
      // For other public URLs, assume they're accessible
      return mediaUrl;
    }

    // If it's a local file path, check if it exists
    if (this.isLocalPath(mediaUrl)) {
      const fullPath = path.join(process.cwd(), mediaUrl);
      if (fs.existsSync(fullPath)) {
        this.logger.log(`Using local file: ${fullPath}`);
        return fullPath;
      } else {
        throw new Error(`Media file not found: ${fullPath}`);
      }
    }

    throw new Error(`Unsupported media URL format: ${mediaUrl}`);
  }

  private isPublicUrl(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://');
  }

  private isLocalPath(url: string): boolean {
    return url.startsWith('/') || url.startsWith('./') || !url.includes('://');
  }

  private isSupabaseUrl(url: string): boolean {
    return url.includes('supabase.co/storage') || url.includes('supabase.storage');
  }
}













