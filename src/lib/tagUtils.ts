export interface ParsedTag {
  source: 'ai' | number; // 'ai' or user FID
  text: string;
  isAI: boolean;
}

/**
 * Parse a tag with attribution format "source:text"
 * Returns { source, text, isAI }
 */
export function parseTag(tag: string): ParsedTag {
  const [source, ...rest] = tag.split(':');
  const text = rest.join(':'); // Handle tags with colons in the text
  
  if (source === 'ai') {
    return { source: 'ai', text, isAI: true };
  }
  
  const userId = parseInt(source, 10);
  return { 
    source: isNaN(userId) ? 'ai' : userId, 
    text: isNaN(userId) ? tag : text, // Fallback for malformed tags
    isAI: false 
  };
}

/**
 * Parse array of attributed tags
 */
export function parseTags(tags?: string[]): ParsedTag[] {
  if (!tags) return [];
  return tags.map(parseTag);
}

/**
 * Get just the tag text without attribution (for display)
 */
export function getTagTexts(tags?: string[]): string[] {
  if (!tags) return [];
  return tags.map(tag => parseTag(tag).text);
}

