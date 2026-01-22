import { Controller, Get, Query, Param, UseGuards, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { LogsService } from './logs.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAuthGuard } from '../auth/supabase.guard';

@Controller('logs')
@UseGuards(SupabaseAuthGuard) // Protect logs endpoint - only authenticated users can view
export class LogsController {
  constructor(
    private readonly logsService: LogsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Get logs with filtering and pagination
   * GET /logs?level=error&service=instagram&page=1&limit=50
   */
  @Get()
  async getLogs(
    @Query('level') level?: string, // 'info', 'warn', 'error', 'debug'
    @Query('service') service?: string, // 'instagram', 'facebook', 'youtube', etc.
    @Query('statusCode', new DefaultValuePipe(undefined), ParseIntPipe) statusCode?: number, // 200, 400, 500, etc.
    @Query('userId') userId?: string,
    @Query('accountId') accountId?: string,
    @Query('method') method?: string, // 'GET', 'POST', 'PUT', 'DELETE'
    @Query('path') path?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number = 1,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number = 50,
    @Query('startDate') startDate?: string, // ISO date string
    @Query('endDate') endDate?: string, // ISO date string
    @Query('minResponseTime', new DefaultValuePipe(undefined), ParseIntPipe) minResponseTime?: number, // milliseconds
  ) {
    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {};

    if (level) {
      where.level = level;
    }

    if (service) {
      where.service = service;
    }

    if (statusCode !== undefined) {
      where.statuscode = statusCode;
    }

    if (userId) {
      where.userid = userId;
    }

    if (accountId) {
      where.accountid = accountId;
    }

    if (method) {
      where.method = method;
    }

    if (path) {
      where.path = { contains: path, mode: 'insensitive' };
    }

    if (minResponseTime !== undefined) {
      where.responsetime = { gte: minResponseTime };
    }

    if (startDate || endDate) {
      where.createdat = {};
      if (startDate) {
        where.createdat.gte = new Date(startDate);
      }
      if (endDate) {
        where.createdat.lte = new Date(endDate);
      }
    }

    // Get logs and total count
    const [logs, total] = await Promise.all([
      this.prisma.log.findMany({
        where,
        orderBy: { createdat: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.log.count({ where }),
    ]);

    return {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get error logs only
   * GET /logs/errors?page=1&limit=50
   */
  @Get('errors')
  async getErrorLogs(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number = 1,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number = 50,
    @Query('service') service?: string,
  ) {
    const skip = (page - 1) * limit;

    const where: any = {
      level: 'error',
    };

    if (service) {
      where.service = service;
    }

    const [logs, total] = await Promise.all([
      this.prisma.log.findMany({
        where,
        orderBy: { createdat: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.log.count({ where }),
    ]);

    return {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get slow requests (high response time)
   * GET /logs/slow?minResponseTime=1000&page=1&limit=50
   */
  @Get('slow')
  async getSlowRequests(
    @Query('minResponseTime', new DefaultValuePipe(1000), ParseIntPipe) minResponseTime: number = 1000,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number = 1,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number = 50,
  ) {
    const skip = (page - 1) * limit;

    const where = {
      responsetime: { gte: minResponseTime },
    };

    const [logs, total] = await Promise.all([
      this.prisma.log.findMany({
        where,
        orderBy: { responsetime: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.log.count({ where }),
    ]);

    return {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get log statistics
   * GET /logs/stats
   */
  @Get('stats')
  async getLogStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const where: any = {};

    if (startDate || endDate) {
      where.createdat = {};
      if (startDate) {
        where.createdat.gte = new Date(startDate);
      }
      if (endDate) {
        where.createdat.lte = new Date(endDate);
      }
    }

    const [
      totalLogs,
      errorLogs,
      warnLogs,
      infoLogs,
      logsByService,
      logsByStatusCode,
      avgResponseTime,
    ] = await Promise.all([
      // Total logs
      this.prisma.log.count({ where }),
      // Error logs
      this.prisma.log.count({ where: { ...where, level: 'error' } }),
      // Warning logs
      this.prisma.log.count({ where: { ...where, level: 'warn' } }),
      // Info logs
      this.prisma.log.count({ where: { ...where, level: 'info' } }),
      // Logs by service
      this.prisma.log.groupBy({
        by: ['service'],
        where,
        _count: true,
      }),
      // Logs by status code
      this.prisma.log.groupBy({
        by: ['statuscode'],
        where: { ...where, statuscode: { not: null } },
        _count: true,
      }),
      // Average response time
      this.prisma.log.aggregate({
        where: { ...where, responsetime: { not: null } },
        _avg: { responsetime: true },
      }),
    ]);

    return {
      total: totalLogs,
      byLevel: {
        error: errorLogs,
        warn: warnLogs,
        info: infoLogs,
      },
      byService: logsByService.map((item) => ({
        service: item.service,
        count: item._count,
      })),
      byStatusCode: logsByStatusCode.map((item) => ({
        statusCode: item.statuscode,
        count: item._count,
      })),
      avgResponseTime: avgResponseTime._avg.responsetime || 0,
    };
  }

  /**
   * Get a single log by ID
   * GET /logs/:id
   */
  @Get(':id')
  async getLogById(@Param('id') id: string) {
    const log = await this.prisma.log.findUnique({
      where: { id },
    });

    if (!log) {
      return { error: 'Log not found' };
    }

    return log;
  }
}

