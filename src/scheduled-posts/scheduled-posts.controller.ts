import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Post,
    Put,
    UseGuards,
    Req,
    UploadedFile,
    UseInterceptors,
    BadRequestException,
  } from '@nestjs/common';
  import { FileInterceptor } from '@nestjs/platform-express';
  import { diskStorage } from 'multer';
  import { randomUUID } from 'crypto';
  import { ScheduledPostsService } from './scheduled-posts.service';
  import { CreateScheduledPostDto } from './dto/create-scheduled-post.dto';
  import { UpdateScheduledPostDto } from './dto/update-scheduled-post.dto';
  import { SupabaseAuthGuard } from '../auth/supabase.guard';
  import type { Request } from 'express';
  import { extname, join } from 'path';
  
  const UPLOAD_DIR = join(process.cwd(), 'uploads');
  
  function filenameGenerator(_req, file, cb) {
    const ext = extname(file.originalname);
    cb(null, `${randomUUID()}${ext}`);
  }
  
  @Controller('scheduled-posts')
  export class ScheduledPostsController {
    constructor(private readonly service: ScheduledPostsService) {}
  
    @UseGuards(SupabaseAuthGuard)
    @Post()
    @UseInterceptors(
      FileInterceptor('media', {
        storage: diskStorage({
          destination: UPLOAD_DIR,
          filename: filenameGenerator,
        }),
        limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
      })
    )
    async create(
      @Req() req: Request,
      @Body() body: CreateScheduledPostDto,
      @UploadedFile() file?: Express.Multer.File
    ) {
      const user = (req as any).user;
      if (!user?.id) throw new BadRequestException('Missing user');
  
      let media;
      if (file) {
        // File uploaded - use local storage
        const url = `/uploads/${file.filename}`; // served by ServeStaticModule
        media = {
          url,
          filename: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
        };
      } else if (body.mediaUrl) {
        // Media URL provided (from Supabase Storage) - use directly
        media = {
          url: body.mediaUrl,
          filename: body.mediaUrl.split('/').pop() || 'media',
        };
      }
  
      const post = await this.service.create(user.id, body, media);
      return post;
    }
  
    @UseGuards(SupabaseAuthGuard)
    @Get()
    async findAll(@Req() req: Request) {
      const user = (req as any).user;
      return this.service.findForUser(user.id);
    }
  
    @UseGuards(SupabaseAuthGuard)
    @Get(':id')
    async findOne(@Req() req: Request, @Param('id') id: string) {
      const user = (req as any).user;
      return this.service.findOne(user.id, id);
    }
  
    @UseGuards(SupabaseAuthGuard)
    @Put(':id')
    async update(
      @Req() req: Request,
      @Param('id') id: string,
      @Body() body: UpdateScheduledPostDto
    ) {
      const user = (req as any).user;
      return this.service.update(user.id, id, body);
    }
  
    @UseGuards(SupabaseAuthGuard)
    @Delete(':id')
    async remove(@Req() req: Request, @Param('id') id: string) {
      const user = (req as any).user;
      return this.service.remove(user.id, id);
    }
  }
  