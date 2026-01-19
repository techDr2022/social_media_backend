import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  getHealth() {
    return { status: 'ok', service: 'api-service' };
  }

  @Get('users')
  async getUsers() {
    const users = await this.prisma.user.findMany();
    return users;
  }
}
