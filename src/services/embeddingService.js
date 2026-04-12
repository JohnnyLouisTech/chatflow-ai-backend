const OpenAI = require('openai');
const { pool } = require('../models/db');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory vector store (production should use Pinecone)
// This implementation works out-of-box without additional services
const vectorStore = new Map(); // websiteId -> [{content, embedding, metadata}]

class EmbeddingService {
  
  async generateEmbeddings(websiteId, pages) {
    logger.info(`Generating embeddings for ${pages.length} pages...`);
    
    const chunks = [];
    
    // Split pages into chunks for better retrieval
    for (const page of pages) {
      const pageChunks = this.chunkText(page.content, 500);
      for (const chunk of pageChunks) {
        chunks.push({
          websiteId,
          url: page.url,
          title: page.title,
          content: chunk
        });
      }
    }

    // Generate embeddings in batches
    const BATCH_SIZE = 20;
    const embeddings = [];
    
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      
      try {
        const response = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: batch.map(c => c.content)
        });

        for (let j = 0; j < batch.length; j++) {
          embeddings.push({
            ...batch[j],
            embedding: response.data[j].embedding
          });
        }

        logger.info(`Embedded batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(chunks.length/BATCH_SIZE)}`);
        
        // Rate limit respect
        await this.sleep(200);
      } catch (err) {
        logger.error(`Embedding batch failed:`, err);
      }
    }

    // Store embeddings
    vectorStore.set(websiteId, embeddings);
    
    // Mark pages as embedded in DB
    await pool.query(
      'UPDATE crawled_pages SET embedded = true WHERE website_id = $1',
      [websiteId]
    );

    logger.info(`✅ Generated ${embeddings.length} embeddings for website ${websiteId}`);
    return embeddings.length;
  }

  async searchSimilar(websiteId, query, topK = 5) {
    // Generate query embedding
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query
    });
    
    const queryEmbedding = response.data[0].embedding;
    const stored = vectorStore.get(websiteId) || [];
    
    if (stored.length === 0) {
      logger.warn(`No embeddings found for website ${websiteId}`);
      return [];
    }

    // Compute cosine similarities
    const similarities = stored.map(item => ({
      content: item.content,
      url: item.url,
      title: item.title,
      score: this.cosineSimilarity(queryEmbedding, item.embedding)
    }));

    // Sort by similarity and return top K
    return similarities
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .filter(item => item.score > 0.3); // Minimum relevance threshold
  }

  cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  chunkText(text, maxTokens) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const chunks = [];
    let current = '';
    
    for (const sentence of sentences) {
      const wouldBe = current + ' ' + sentence;
      const estimatedTokens = wouldBe.length / 4;
      
      if (estimatedTokens > maxTokens && current.length > 0) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current = wouldBe;
      }
    }
    
    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }
    
    return chunks.filter(c => c.length > 50); // Skip very short chunks
  }

  hasEmbeddings(websiteId) {
    return vectorStore.has(websiteId) && vectorStore.get(websiteId).length > 0;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new EmbeddingService();
