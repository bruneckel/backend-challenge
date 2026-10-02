import { AsyncResource } from 'node:async_hooks';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';

interface ObservedRequest {
  method: string;
  baseUrl?: string;
  originalUrl?: string;
  route?: { path?: unknown };
}

interface ObservedResponse {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}

const QUIET_PREFIXES = ['/health', '/metrics'];

function routeOf(request: ObservedRequest): string {
  const path = request.route?.path;
  return typeof path === 'string'
    ? `${request.baseUrl ?? ''}${path}`
    : 'unmatched';
}

export function httpObservability(metrics: Metrics, logger: Logger) {
  return (
    request: ObservedRequest,
    response: ObservedResponse,
    next: () => void,
  ): void => {
    const url = request.originalUrl ?? '';
    if (QUIET_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      next();
      return;
    }
    const started = performance.now();
    response.on(
      'finish',
      AsyncResource.bind(() => {
        const seconds = (performance.now() - started) / 1000;
        const route = routeOf(request);
        metrics.observe('http_request_duration_seconds', seconds, {
          method: request.method,
          route,
          status: String(response.statusCode),
        });
        logger.info('http request completed', {
          method: request.method,
          route,
          status: response.statusCode,
          durationMs: Math.round(seconds * 1000),
        });
      }),
    );
    next();
  };
}
