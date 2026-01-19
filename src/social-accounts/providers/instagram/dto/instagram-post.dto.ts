export class InstagramPostDto {
  caption?: string;
  mediaUrl?: string;
  mediaType?: 'photo' | 'video' | 'carousel';
  scheduledPublishTime?: string;
  locationId?: string; // Instagram location ID for tagging
  userTags?: string; // Comma-separated user IDs to tag
}


