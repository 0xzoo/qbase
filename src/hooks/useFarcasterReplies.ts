import { useState, useEffect, useCallback } from 'react';

/**
 * Represents a Farcaster reply to a cast
 */
export interface FarcasterReply {
  hash: string;
  text: string;
  author: {
    fid: number;
    username: string;
    display_name: string;
    pfp_url?: string;
  };
  timestamp: string;
  reactions: {
    likes_count: number;
    recasts_count: number;
  };
  replies: {
    count: number;
  };
}

/**
 * Fresh engagement data from Farcaster for the parent cast
 */
export interface CastEngagement {
  likes_count: number;
  recasts_count: number;
  replies_count: number;
}

interface UseFarcasterRepliesResult {
  replies: FarcasterReply[];
  /** Fresh engagement data for the parent cast (likes, recasts, replies) */
  engagement: CastEngagement | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch Farcaster replies and engagement data for a cast
 * @param castHash - The hash of the cast to fetch replies for (optional - no fetch if not provided)
 * @param viewerFid - Optional viewer FID for personalized responses
 */
export function useFarcasterReplies(
  castHash?: string | null,
  viewerFid?: number
): UseFarcasterRepliesResult {
  const [replies, setReplies] = useState<FarcasterReply[]>([]);
  const [engagement, setEngagement] = useState<CastEngagement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReplies = useCallback(async () => {
    if (!castHash) {
      setReplies([]);
      setEngagement(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (viewerFid) {
        params.set('viewer_fid', viewerFid.toString());
      }
      params.set('limit', '50');

      const queryString = params.toString();
      const url = `/api/farcaster/conversation/${castHash}${queryString ? `?${queryString}` : ''}`;

      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 404) {
          // Cast not found - not an error, just no replies
          setReplies([]);
          setEngagement(null);
        } else {
          throw new Error(`Failed to fetch replies: ${response.statusText}`);
        }
      } else {
        const data = await response.json();
        setReplies(data.replies || []);
        
        // Extract fresh engagement data from parent cast
        if (data.cast) {
          setEngagement({
            likes_count: data.cast.reactions?.likes_count || 0,
            recasts_count: data.cast.reactions?.recasts_count || 0,
            replies_count: data.cast.replies?.count || 0,
          });
        } else {
          setEngagement(null);
        }
      }
    } catch (err) {
      console.error('Error fetching Farcaster replies:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch replies');
      setReplies([]);
      setEngagement(null);
    } finally {
      setLoading(false);
    }
  }, [castHash, viewerFid]);

  useEffect(() => {
    fetchReplies();
  }, [fetchReplies]);

  return { replies, engagement, loading, error, refetch: fetchReplies };
}

