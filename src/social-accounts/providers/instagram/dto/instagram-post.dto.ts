export class InstagramPostDto {
  caption?: string;
  mediaUrl?: string;
  mediaType?: 'photo' | 'video' | 'carousel';
  scheduledPublishTime?: string;
  locationId?: string; // Instagram location ID for tagging
  userTags?: string; // Comma-separated user IDs to tag
  carouselUrls?: string[]; // Array of image URLs for carousel posts (deprecated - use carouselItems)
  carouselItems?: Array<{url: string; type: 'photo' | 'video'}>; // Array of carousel items with type
}


