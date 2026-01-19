export class YoutubeUploadDto {
  title: string;
  description?: string;

  // REQUIRED by YouTube
  categoryId: string;

  // private | unlisted | public
  privacyStatus: 'private' | 'unlisted' | 'public';

  // ISO string (optional)
  publishAt?: string;

  // Audience
  madeForKids?: boolean;

  // Optional extra metadata coming from the frontend
  // Comma‑separated tags string from the UI
  tags?: string;

  // ISO 639‑1 language code (e.g. "en")
  language?: string;

  // "youtube" | "creativeCommon"
  license?: string;

  // Frontend flags – currently not all are used by YouTube directly,
  // but we keep them for future expansion.
  commentsEnabled?: boolean;
  ageRestricted?: boolean;
}
