import { DUPLICATE_THRESHOLD, SIMILARITY_THRESHOLD, SUGGESTION_MIN_SCORE } from '../../src/lib/consts'
import type {
  EmbeddingResponse,
  VectorizeMatch,
  VectorizeMatches,
  SearchResult,
  SimilarityCheckResponse
} from '../../src/lib/types'

export type QbaseVectorizeIndex = 'q' | 'a'

export class VectorService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private q_index: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private a_index: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ai: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(q_index: any, a_index: any, ai: any) {
    this.q_index = q_index
    this.a_index = a_index
    this.ai = ai
  }

  /**
   * Generate embedding text using selective strategy:
   * - For template questions (incomplete stems): include options in embedding
   * - For complete questions: stem only
   * 
   * @param stem The question stem
   * @param options Question options (if any)
   * @param isTemplate Whether the question is a template (from taxonomy.is_template)
   */
  generateEmbeddingText(
    stem: string,
    options: string[] | undefined,
    isTemplate: boolean
  ): string {
    // For template questions, options are part of the question's meaning
    // Example: "Would you rather:" [be rich] or [be famous]
    // Embedding should include both stem and options for semantic matching
    if (isTemplate && options && options.length > 0) {
      return `${stem} ${options.join(' ')}`;
    }
    
    // For complete questions, stem only (options can vary freely without changing meaning)
    // Example: "What's your favorite color?" - options like [red, blue, green] are just UI aids
    return stem;
  }

  async vectorize(text: string): Promise<number[]> {
    console.log('Vectorizing text:', text.substring(0, 50) + '...');
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const modelResp: EmbeddingResponse = await this.ai.run(
          "@cf/baai/bge-base-en-v1.5",
          {
            text: text,
          },
        ) as EmbeddingResponse

        console.log('Vectorization complete. Shape:', modelResp.shape);
        return modelResp.data[0]
      } catch (e: unknown) {
        attempts++;
        const error = e as Error;
        console.error(`Error in vectorize (attempt ${attempts}/${maxAttempts}):`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

        // Check for specific error codes that might benefit from a retry
        // 1031 seems to be a generic upstream error
        if (attempts >= maxAttempts) {
          throw error;
        }

        // Wait a bit before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempts)));
      }
    }
    throw new Error('Failed to vectorize after max attempts');
  }

  async addVectors(
    vectors: { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> }[],
    index: QbaseVectorizeIndex
  ): Promise<{ mutationId: string; ids: string[] }> {
    // if (vector.length !== metadata.dimensions) {
    //   throw new Error(`Vector length ${vector.length} does not match specified dimensions ${metadata.dimensions}`)
    // }
    if (index === 'q') {
      const results = await this.q_index.insert(vectors)
      return results
    } else if (index === 'a') {
      const results = await this.a_index.insert(vectors)
      return results
    }
    throw new Error(`Invalid index: ${index}`)
  }

  /**
   * Insert or overwrite by id. A re-scope re-adds an evicted entry or refreshes
   * the metadata of one that exists (Public ↔ Anon); `insert` would skip the
   * latter.
   */
  async upsertVectors(
    vectors: { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> }[],
    index: QbaseVectorizeIndex
  ): Promise<{ mutationId: string; ids: string[] }> {
    const target = index === 'q' ? this.q_index : this.a_index;
    return target.upsert(vectors)
  }

  async deleteVectors(
    ids: string[],
    index: QbaseVectorizeIndex
  ): Promise<{ mutationId: string; count: number }> {
    if (index === 'q') {
      const results = await this.q_index.deleteByIds(ids)
      return results
    } else if (index === 'a') {
      const results = await this.a_index.deleteByIds(ids)
      return results
    }
    throw new Error(`Invalid index: ${index}`)
  }

  async getVectorsByIds(
    ids: string[],
    index: QbaseVectorizeIndex
  ): Promise<{ id: string }[]> {
    if (ids.length === 0) return []
    const target = index === 'q' ? this.q_index : index === 'a' ? this.a_index : null
    if (!target) throw new Error(`Invalid index: ${index}`)
    const results = await target.getByIds(ids)
    return Array.isArray(results) ? results : []
  }

  async searchSimilar(queryVector: number[], index: QbaseVectorizeIndex, limit?: number): Promise<SearchResult[]> {
    console.log(`Searching similar vectors in index: ${index}`);
    // Fetch vectors from DB with proper query options
    limit = limit ?? 5
    let vectorRows: VectorizeMatches;

    try {
      if (index === 'q') {
        vectorRows = await this.q_index.query(queryVector, {
          topK: limit,
          returnValues: false,
          returnMetadata: 'all'
        }) as VectorizeMatches;
      } else if (index === 'a') {
        vectorRows = await this.a_index.query(queryVector, {
          topK: limit,
          returnValues: false,
          returnMetadata: 'all'
        }) as VectorizeMatches;
      } else {
        throw new Error(`Invalid index: ${index}`);
      }

      console.log(`Found ${vectorRows.matches.length} matches`);

      // Map the results to our SearchResult type
      // Pass through the actual metadata from the vector index
      const results = vectorRows.matches.map((row: VectorizeMatch): SearchResult => ({
        id: row.id,
        score: row.score,
        metadata: row.metadata || {
          dimensions: 768,
          model: 'cloudflare:cf/baai/bge-base-en-v1.5' as const,
          created_at: new Date().toISOString(),
          _id: row.id,
          topics: []
        }
      }));

      // Results are already sorted by score from the Vectorize query
      return results.slice(0, limit);
    } catch (e) {
      console.error('Error in searchSimilar:', e);
      throw e;
    }
  }

  /**
   * Check if a question is similar to existing questions
   * @param text The question text to check
   * @returns Status and any similar results found
   */
  async checkSimilarity(text: string): Promise<SimilarityCheckResponse> {
    console.log('Checking similarity for:', text.substring(0, 50));
    try {
      // Vectorize question
      const vector = await this.vectorize(text)
      // Check if question is unique
      const results = await this.searchSimilar(vector, 'q')

      // Status is decided by the top match, but the suggestion list shown to the
      // user is filtered to relevant matches only — searchSimilar returns the
      // top-K regardless of score, so low-relevance tail entries would otherwise
      // appear as "suggested questions" unrelated to the input.
      const suggestions = results.filter(r => r.score >= SUGGESTION_MIN_SCORE)

      // If exact duplicate (very high similarity)
      if (results.length && results[0].score > DUPLICATE_THRESHOLD) {
        return { status: 'duplicate', results: suggestions, id: results[0].id }
      }

      // If similar but not duplicate
      if (results.length && results[0].score > SIMILARITY_THRESHOLD) {
        return { status: 'similar', results: suggestions }
      }

      return { status: 'unique', results: [] }
    } catch (error) {
      console.error('Error in checkSimilarity:', error);
      throw error
    }
  }

  // Create a static factory method for easy instantiation with env
  static fromEnv(env: {
    QINDEX: unknown;
    AINDEX: unknown;
    AI: unknown;
  }): VectorService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new VectorService(env.QINDEX as any, env.AINDEX as any, env.AI as any);
  }

  // private async cosineSimilarity(a: number[], b: number[]): Promise<number> {
  //   if (a.length !== b.length) {
  //     throw new Error('Cannot compute similarity between vectors of different dimensions')
  //   }
  //   const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0)
  //   const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
  //   const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
  //   return dotProduct / (normA * normB)
  // }
}
