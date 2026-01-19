export class FacebookPostDto {
  message?: string;
  link?: string;
  scheduledPublishTime?: string;
  mediaUrl?: string;
  mediaType?: 'photo' | 'video';
  collaborator?: string; // Collaborator name or URL
  shareToStory?: boolean; // Share to story option
  privacy?: 'PUBLIC' | 'FRIENDS' | 'CUSTOM'; // Privacy setting
  privacyValue?: string; // For CUSTOM privacy (comma-separated user IDs or friend list ID)
}






