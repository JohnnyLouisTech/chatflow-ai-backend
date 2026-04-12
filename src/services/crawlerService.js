const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { pool } = require('../models/db');
const embeddingService = require('./embeddingService');
const logger = require('../utils/logger');

const PLAN_LIMITS = {
  free: { pages: 10, websites: 1, messages: 100 },
  pro: { pages: 100, websites: 3, messages: 2000 },
  business: { pages: 500, websites: 10, messages: 10000 }
};

class CrawlerService {
  constructor() {
    this.visited = new Set();
    this.queue = [];
    this.results = [];
  }

  async crawlWebsite(websiteId, userId, maxPages) {
    const website = await pool.query(
      'SELECT * FROM websites WHERE id = $1 AND user_id = $2',
      [websiteId, userId]
    );

    if (!website.rows.length) {
      throw new Error('Website not found');
    }

    const site = website.rows[0];
    
    // Create training job
    const jobResult = await pool.query(
      `INSERT INTO training_jobs (website_id, status, started_at) 
       VALUES ($1, 'running', NOW()) RETURNING id`,
      [websiteId]
    );
    const jobId = jobResult.rows[0].id;

    // Update website status
    await pool.query(
      "UPDATE websites SET status = 'training' WHERE id = $1",
      [websiteId]
    );

    try {
      logger.info(`Starting crawl for ${site.url}, max pages: ${maxPages}`);
      
      this.visited = new Set();
      this.queue = [site.url];
      this.results = [];

      // Delete old pages
      await pool.query('DELETE FROM crawled_pages WHERE website_id = $1', [websiteId]);

      while (this.queue.length > 0 && this.results.length < maxPages) {
        const url = this.queue.shift();
        
        if (this.visited.has(url)) continue;
        this.visited.add(url);

        try {
          const pageData = await this.crawlPage(url, site.url);
          if (pageData) {
            this.results.push(pageData);
            
            // Save page to DB
            await pool.query(
              `INSERT INTO crawled_pages (website_id, url, title, content, tokens_count) 
               VALUES ($1, $2, $3, $4, $5)`,
              [websiteId, pageData.url, pageData.title, pageData.content, 
               Math.ceil(pageData.content.length / 4)]
            );

            // Update job progress
            await pool.query(
              'UPDATE training_jobs SET pages_processed = $1 WHERE id = $2',
              [this.results.length, jobId]
            );

            // Add discovered links to queue
            pageData.links.forEach(link => {
              if (!this.visited.has(link) && !this.queue.includes(link)) {
                this.queue.push(link);
              }
            });
          }
        } catch (pageErr) {
          logger.warn(`Failed to crawl ${url}: ${pageErr.message}`);
        }

        // Rate limiting - be respectful
        await this.sleep(300);
      }

      // Generate embeddings
      logger.info(`Crawled ${this.results.length} pages, generating embeddings...`);
      await embeddingService.generateEmbeddings(websiteId, this.results);

      // Update website as trained
      await pool.query(
        `UPDATE websites SET status = 'trained', pages_crawled = $1, last_trained_at = NOW() WHERE id = $2`,
        [this.results.length, websiteId]
      );

      // Complete job
      await pool.query(
        `UPDATE training_jobs SET status = 'completed', pages_found = $1, completed_at = NOW() WHERE id = $2`,
        [this.results.length, jobId]
      );

      logger.info(`✅ Training complete for website ${websiteId}: ${this.results.length} pages`);
      return { pagesCount: this.results.length, jobId };

    } catch (err) {
      logger.error(`Crawl failed for website ${websiteId}:`, err);
      
      await pool.query(
        `UPDATE websites SET status = 'error', training_error = $1 WHERE id = $2`,
        [err.message, websiteId]
      );
      
      await pool.query(
        `UPDATE training_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, jobId]
      );

      throw err;
    }
  }

  async crawlPage(url, baseUrl) {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'ChatFlowAI-Bot/1.0 (Website training crawler)',
        'Accept': 'text/html'
      },
      maxRedirects: 3
    });

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html')) return null;

    const $ = cheerio.load(response.data);

    // Remove unwanted elements
    $('script, style, nav, header, footer, .nav, .navigation, .menu, .sidebar, .ad, .ads, .advertisement, iframe, noscript, .cookie-banner, [role="banner"], [role="navigation"]').remove();

    // Extract title
    const title = $('title').text().trim() || $('h1').first().text().trim() || url;

    // Extract main content
    let content = '';
    const mainContent = $('main, article, .content, .main-content, #content, #main').first();
    
    if (mainContent.length) {
      content = mainContent.text();
    } else {
      content = $('body').text();
    }

    // Clean up content
    content = content
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim()
      .substring(0, 10000); // Cap at 10k chars per page

    if (content.length < 100) return null; // Skip very short pages

    // Extract links from same domain
    const links = [];
    const baseDomain = new URL(baseUrl).hostname;
    
    $('a[href]').each((_, el) => {
      try {
        const href = $(el).attr('href');
        const absoluteUrl = new URL(href, url).toString();
        const urlObj = new URL(absoluteUrl);
        
        // Same domain, HTTP/HTTPS, no anchors, no query strings for common patterns
        if (urlObj.hostname === baseDomain && 
            ['http:', 'https:'].includes(urlObj.protocol) &&
            !absoluteUrl.includes('#') &&
            !absoluteUrl.match(/\.(pdf|jpg|jpeg|png|gif|css|js|xml|json|zip|mp4|mp3)$/i)) {
          links.push(absoluteUrl.split('?')[0]); // Remove query strings
        }
      } catch (e) {}
    });

    return {
      url,
      title: title.substring(0, 200),
      content,
      links: [...new Set(links)] // Deduplicate
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new CrawlerService();
module.exports.PLAN_LIMITS = PLAN_LIMITS;
