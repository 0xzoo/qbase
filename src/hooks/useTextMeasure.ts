import { useCallback, useRef } from 'react';
import { prepare, layout, prepareWithSegments, layoutWithLines } from '@chenglou/pretext';

/**
 * Pretext-powered text measurement hook.
 * Measures text height and line count WITHOUT triggering DOM layout reflow.
 * 
 * Usage:
 *   const { measureHeight, measureLines, getLines } = useTextMeasure('1rem Inter', 24);
 *   const { height, lineCount } = measureHeight(text, containerWidth);
 */

interface TextMeasurement {
  height: number;
  lineCount: number;
}

interface TextLine {
  text: string;
  width: number;
}

interface UseTextMeasureOptions {
  /** CSS font shorthand, e.g. '16px Inter' or '1rem "Helvetica Neue"' */
  font: string;
  /** Line height in pixels */
  lineHeight: number;
}

export function useTextMeasure({ font, lineHeight }: UseTextMeasureOptions) {
  // Cache prepared texts to avoid re-preparing on re-renders
  const cache = useRef(new Map<string, ReturnType<typeof prepare>>());
  const segCache = useRef(new Map<string, ReturnType<typeof prepareWithSegments>>());

  const getPrepared = useCallback((text: string) => {
    const cached = cache.current.get(text);
    if (cached) return cached;
    const prepared = prepare(text, font);
    cache.current.set(text, prepared);
    return prepared;
  }, [font]);

  const getPreparedWithSegments = useCallback((text: string) => {
    const cached = segCache.current.get(text);
    if (cached) return cached;
    const prepared = prepareWithSegments(text, font);
    segCache.current.set(text, prepared);
    return prepared;
  }, [font]);

  /** Measure height and line count — pure arithmetic, no DOM */
  const measureHeight = useCallback((text: string, maxWidth: number): TextMeasurement => {
    if (!text) return { height: 0, lineCount: 0 };
    const prepared = getPrepared(text);
    return layout(prepared, maxWidth, lineHeight);
  }, [getPrepared, lineHeight]);

  /** Get actual line objects for manual rendering */
  const getLines = useCallback((text: string, maxWidth: number): TextLine[] => {
    if (!text) return [];
    const prepared = getPreparedWithSegments(text);
    const { lines } = layoutWithLines(prepared, maxWidth, lineHeight);
    return lines.map(l => ({ text: l.text, width: l.width }));
  }, [getPreparedWithSegments, lineHeight]);

  /** Check if text exceeds N lines at a given width */
  const exceedsLines = useCallback((text: string, maxWidth: number, maxLines: number): boolean => {
    if (!text) return false;
    const { lineCount } = measureHeight(text, maxWidth);
    return lineCount > maxLines;
  }, [measureHeight]);

  /** Get truncated text that fits within N lines, with ellipsis */
  const truncateToLines = useCallback((text: string, maxWidth: number, maxLines: number): string => {
    if (!text) return '';
    const prepared = getPreparedWithSegments(text);
    const { lines } = layoutWithLines(prepared, maxWidth, lineHeight);
    if (lines.length <= maxLines) return text;
    // Join first N lines and add ellipsis
    const truncated = lines.slice(0, maxLines).map(l => l.text).join('');
    return truncated.trimEnd() + '\u2026';
  }, [getPreparedWithSegments, lineHeight]);

  /** Clear internal caches (useful if font changes) */
  const clearCache = useCallback(() => {
    cache.current.clear();
    segCache.current.clear();
  }, []);

  return {
    measureHeight,
    getLines,
    exceedsLines,
    truncateToLines,
    clearCache,
  };
}
