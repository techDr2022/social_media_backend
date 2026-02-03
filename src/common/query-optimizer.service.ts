import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Query Optimizer Service
 * 
 * Provides utilities for optimized database queries:
 * - Pagination
 * - Batch loading (prevent N+1)
 * - Query optimization
 */
@Injectable()
export class QueryOptimizerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Paginate results
   */
  async paginate<T>(
    queryFn: (skip: number, take: number) => Promise<T[]>,
    countFn: () => Promise<number>,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    data: T[];
    total: number;
    page: number;
    limit: number;
    pages: number;
  }> {
    const skip = (page - 1) * limit;
    const validPage = Math.max(1, page);
    const validLimit = Math.min(Math.max(1, limit), 100); // Max 100 per page

    const [data, total] = await Promise.all([
      queryFn((validPage - 1) * validLimit, validLimit),
      countFn(),
    ]);

    return {
      data,
      total,
      page: validPage,
      limit: validLimit,
      pages: Math.ceil(total / validLimit),
    };
  }

  /**
   * Batch load relations (prevent N+1 queries)
   */
  async batchLoadRelations<T extends { id: string }>(
    items: T[],
    relationKey: string,
    loader: (ids: string[]) => Promise<Array<{ id: string }>>,
  ): Promise<T[]> {
    if (items.length === 0) {
      return items;
    }

    const ids = items
      .map((item) => (item as any)[relationKey])
      .filter(Boolean)
      .filter((id, index, self) => self.indexOf(id) === index); // Unique IDs

    if (ids.length === 0) {
      return items;
    }

    const relations = await loader(ids);
    const relationMap = new Map(relations.map((r) => [r.id, r]));

    return items.map((item) => ({
      ...item,
      [relationKey]: relationMap.get((item as any)[relationKey]) || null,
    })) as T[];
  }

  /**
   * Select only needed fields (reduce data transfer)
   */
  selectFields<T>(fields: string[]): Record<string, boolean> {
    const select: Record<string, boolean> = {};
    for (const field of fields) {
      select[field] = true;
    }
    return select as any;
  }
}
