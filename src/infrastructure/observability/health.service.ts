import { Redis } from 'ioredis';
import type { AppConfig } from '../../config/env';
import { prisma } from '../database/prisma';

export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: 'up' | 'down';
    redis: 'up' | 'down' | 'disabled';
  };
  details?: Record<string, string>;
  checkedAt: string;
}

export class HealthService {
  constructor(private readonly config: AppConfig) {}

  liveness() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessResult> {
    const details: Record<string, string> = {};
    let database: 'up' | 'down' = 'up';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      database = 'down';
      details.database = error instanceof Error ? error.message : 'Database probe failed';
    }

    let redis: 'up' | 'down' | 'disabled' = 'disabled';
    if (this.config.QUEUE_ENABLED && this.config.REDIS_URL) {
      try {
        redis = (await this.probeRedis(this.config.REDIS_URL)) ? 'up' : 'down';
        if (redis === 'down') details.redis = 'PING failed';
      } catch (error) {
        redis = 'down';
        details.redis = error instanceof Error ? error.message : 'Redis probe failed';
      }
    }

    return {
      ready: database === 'up' && redis !== 'down',
      checks: { database, redis },
      ...(Object.keys(details).length > 0 ? { details } : {}),
      checkedAt: new Date().toISOString(),
    };
  }

  private async probeRedis(url: string): Promise<boolean> {
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 1_500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      return (await client.ping()) === 'PONG';
    } finally {
      client.disconnect();
    }
  }
}
