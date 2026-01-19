import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type CreateUserInput = {
  id: string; // supabase user id (uuid)
  email?: string | null;
  name?: string | null;
};

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /**
   * Create user row if it does not exist. Returns the user row.
   */
  async createIfNotExists(input: CreateUserInput) {
    return this.prisma.user.upsert({
      where: { id: input.id },
      update: {
        email: input.email ?? undefined,
      },
      create: {
        id: input.id,
        email: input.email ?? '',
        plan: 'free', // or default
      },
    });
  }
  
  async updateProfile(id: string, data: Partial<CreateUserInput>) {
    return this.prisma.user.update({
      where: { id },
      data: data as any,
    });
  }
}
