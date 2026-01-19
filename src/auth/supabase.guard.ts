import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import type { Request } from 'express';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY! // server key
  );

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers['authorization'] || '';
    const token = (Array.isArray(auth) ? auth[0] : auth).replace(/^Bearer\s+/i, '');

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    // Verify token by calling Supabase auth.getUser
    const { data, error } = await this.supabase.auth.getUser(token);

    if (error || !data?.user) {
      throw new UnauthorizedException('Invalid token');
    }

    // attach user info onto request for controllers
    (req as any).user = {
      id: data.user.id,
      email: data.user.email,
    };

    return true;
  }
}
