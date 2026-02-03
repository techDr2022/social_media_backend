/**
 * Type definitions for post publishing jobs
 */

export interface PublishPostJobData {
  postId: string;
  userId: string;
  socialAccountId: string;
  platform: 'instagram' | 'facebook' | 'youtube';
  content: string;
  mediaUrl?: string;
  mediaType?: string;
  type?: string;
}

export interface PublishPostJobResult {
  success: boolean;
  postId?: string;
  postUrl?: string;
  error?: string;
}

/**
 * Queue names
 */
export const QUEUE_NAMES = {
  POST_PUBLISH: 'post-publish',
} as const;

/**
 * Job names
 */
export const JOB_NAMES = {
  PUBLISH_POST: 'publish-post',
} as const;

















