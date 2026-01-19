import { Test, TestingModule } from '@nestjs/testing';
import { ScheduledPostsController } from './scheduled-posts.controller';

describe('ScheduledPostsController', () => {
  let controller: ScheduledPostsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScheduledPostsController],
    }).compile();

    controller = module.get<ScheduledPostsController>(ScheduledPostsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
