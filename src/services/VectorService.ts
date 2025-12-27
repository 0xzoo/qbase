import type { SimilarityCheckResponse } from '../lib/types';

export class VectorService {
  /**
   * Check if a question is similar to existing questions by calling the worker API
   * @param text The question text to check
   * @returns Status and any similar results found
   */
  static async checkSimilarity(text: string): Promise<SimilarityCheckResponse> {
    try {
      const res = await fetch('/api/check-similarity', {
        method: 'POST',
        body: JSON.stringify({ text }),
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res.ok) {
        throw new Error(`Error checking similarity: ${res.statusText}`);
      }

      return await res.json();
    } catch (error) {
      console.error("VectorService checkSimilarity error:", error);
      // Return a safe fallback or rethrow
      throw error;
    }
  }
}