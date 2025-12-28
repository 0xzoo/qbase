import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

interface DevOnlyRouteProps {
  children: ReactNode;
}

/**
 * A component that only renders its children when on the dev domain.
 * Redirects to the home page on other domains.
 */
export default function DevOnlyRoute({ children }: DevOnlyRouteProps) {
  const isDevDomain = window.location.hostname === 'qbase-dev.z00.workers.dev';

  if (!isDevDomain) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

