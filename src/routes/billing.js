const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../models/db');
const logger = require('../utils/logger');

const PLANS = {
  free: { priceId: null, name: 'Free', amount: 0 },
  pro: { priceId: process.env.STRIPE_PRO_PRICE_ID, name: 'Pro', amount: 2900 },
  business: { priceId: process.env.STRIPE_BUSINESS_PRICE_ID, name: 'Business', amount: 7900 }
};

// Create checkout session
router.post('/checkout', async (req, res, next) => {
  try {
    const { plan } = req.body;
    
    if (!['pro', 'business'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const planConfig = PLANS[plan];
    if (!planConfig.priceId) {
      return res.status(400).json({ error: 'Price not configured' });
    }

    // Get or create Stripe customer
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];

    let customerId = user.stripe_customer_id;
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user.id }
      });
      customerId = customer.id;
      
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, user.id]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: planConfig.priceId,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/dashboard?upgraded=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: {
        userId: user.id,
        plan
      },
      subscription_data: {
        metadata: { userId: user.id, plan }
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.error('Checkout error:', err);
    next(err);
  }
});

// Customer portal
router.post('/portal', async (req, res, next) => {
  try {
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );
    
    const customerId = userResult.rows[0]?.stripe_customer_id;
    
    if (!customerId) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.FRONTEND_URL}/dashboard/billing`
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// Get current subscription info
router.get('/subscription', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT plan, subscription_status, subscription_current_period_end, 
       stripe_subscription_id, messages_used_this_month
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    
    res.json({ subscription: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
