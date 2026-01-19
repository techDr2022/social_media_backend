import {
  Controller,
  Post,
  UseGuards,
  Req,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor, AnyFilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { SupabaseAuthGuard } from '../../../auth/supabase.guard';
import { YoutubeService } from './youtube.service';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { YoutubeUploadDto } from './dto/youtube-upload.dto';

@Controller('youtube')
export class YoutubeController {
  constructor(private readonly youtubeService: YoutubeService) {}

  @UseGuards(SupabaseAuthGuard)
  @Post('upload/:accountId')
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: diskStorage({
        destination: 'uploads',
        filename: (_, file, cb) => {
          cb(null, `${randomUUID()}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
    }),
  )
  async upload(
    @Req() req,
    @Body() body: YoutubeUploadDto & { socialAccountId: string },
  ) {
    const files = (req as any).files as Express.Multer.File[];
    if (!files || files.length === 0) {
      throw new Error('Video file is required');
    }

    // Find video and thumbnail files
    const file = files.find(f => f.fieldname === 'video');
    const thumbnailFile = files.find(f => f.fieldname === 'thumbnail');

    if (!file) {
      throw new Error('Video file is required');
    }

    // Parse tags from comma-separated string (if provided)
    const tags = body.tags
      ? String(body.tags)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    // Parse boolean values from form data (they come as strings)
    const parseBoolean = (value: any): boolean => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toLowerCase() === 'true';
      return Boolean(value);
    };

    const madeForKids = parseBoolean(body.madeForKids);
    const commentsEnabled = parseBoolean(body.commentsEnabled);
    const ageRestricted = parseBoolean(body.ageRestricted);

    return this.youtubeService.uploadVideo({
      userId: req.user.id,
      socialAccountId: body.socialAccountId,
      filePath: file.path,
      thumbnailPath: thumbnailFile?.path,
      title: body.title,
      description: body.description,
      privacyStatus: body.privacyStatus,
      categoryId: body.categoryId,
      publishAt: body.publishAt,
      madeForKids,
      language: body.language,
      license: body.license,
      tags,
      commentsEnabled,
      ageRestricted,
    });
  }
}
