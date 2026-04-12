const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../models/db');
const logger = require('../utils/logger');

router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  logger.info(`Stripe webhook: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const plan = session.metadata?.plan;
        
        if (userId && plan) {
          await pool.query(
            `UPDATE users SET 
             plan = $1, 
             stripe_subscription_id = $2,
             subscription_status = 'active',
             updated_at = NOW()
             WHERE id = $3`,
            [plan, session.subscription, userId]
          );
          logger.info(`User ${userId} upgraded to ${plan}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const planMetadata = subscription.metadata?.plan;
        
        const userResult = await pool.query(
          'SELECT id FROM users WHERE stripe_subscription_id = $1',
          [subscription.id]
        );

        if (userResult.rows.length) {
          const userId = userResult.rows[0].id;
          const status = subscription.status;
          const periodEnd = new Date(subscription.current_period_end * 1000);
          
          await pool.query(
            `UPDATE users SET 
             subscription_status = $1,
             subscription_current_period_end = $2,
             plan = COALESCE($3, plan),
             updated_at = NOW()
             WHERE id = $4`,
            [status, periodEnd, planMetadata, userId]
          );
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        
        const userResult = await pool.query(
          'SELECT id FROM users WHERE stripe_subscription_id = $1',
          [subscription.id]
        );

        if (userResult.rows.length) {
          await pool.query(
            `UPDATE users SET 
             plan = 'free',
             subscription_status = 'cancelled',
             stripe_subscription_id = NULL,
             updated_at = NOW()
             WHERE id = $1`,
            [userResult.rows[0].id]
          );
          logger.info(`Subscription cancelled for user ${userResult.rows[0].id}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        
        await pool.query(
          `UPDATE users SET subscription_status = 'past_due' WHERE stripe_customer_id = $1`,
          [customerId]
        );
        break;
      }
    }

    // Log billing event
    if (event.data.object.metadata?.userId) {
      await pool.query(
        `INSERT INTO billing_events (user_id, event_type, stripe_event_id, metadata)
         VALUES ($1, $2, $3, $4)`,
        [
          event.data.object.metadata.userId,
          event.type,
          event.id,
          JSON.stringify(event.data.object)
        ]
      ).catch(err => logger.warn('Failed to log billing event:', err));
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
