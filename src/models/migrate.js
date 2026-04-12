require('dotenv').config();
const { migrate } = require('./db');

migrate()
  .then(() => {
    console.log('✅ Migrations complete');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  });
