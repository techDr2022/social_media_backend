import { PartialType } from '@nestjs/mapped-types';
import { CreateScheduledPostDto } from './create-scheduled-post.dto';

export class UpdateScheduledPostDto extends PartialType(CreateScheduledPostDto) {}
