import { IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateScheduledPostDto {
  @IsNotEmpty()
  @IsString()
  platform: string;

  @IsNotEmpty()
  @IsString()
  content: string;

  @IsNotEmpty()
  @IsISO8601()
  scheduledAt: string; // ISO string

  @IsNotEmpty()
  @IsString()
  socialAccountId: string; // REQUIRED now

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  mediaUrl?: string; // Support direct media URL (from Supabase Storage)

  /** JSON string array of carousel media URLs (e.g. from FormData). */
  @IsOptional()
  @IsString()
  carouselUrls?: string;

  /** JSON string array of { url, type: 'photo'|'video' } for Instagram carousel. */
  @IsOptional()
  @IsString()
  carouselItems?: string;
}
