const { Client } = require('@notionhq/client');
const axios = require('axios');
const { format, parseISO } = require('date-fns');
const { utcToZonedTime } = require('date-fns-tz');

// Configuration
const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const NOTION_API_KEY = process.env.NOTION_API_KEY;

// Your Notion Database IDs
const PRODUCTS_DATABASE_ID = '22ab2975e0b7804cbcdaf8b5e6b37d19';
const ORDERS_DATABASE_ID = '22ab2975e0b78062a20dcf23fedb342e';

// Initialize Notion client
const notion = new Client({ auth: NOTION_API_KEY });

// Shopify API configuration
const shopifyAPI = axios.create({
  baseURL: `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-10`,
  headers: {
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json'
  }
});

// Helper function to handle rate limits
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to handle Shopify API calls with retry
async function shopifyAPICall(endpoint, params = {}) {
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await shopifyAPI.get(endpoint, { params });
      return response.data;
    } catch (error) {
      if (error.response?.status === 429) {
        // Rate limited - wait and retry
        const retryAfter = error.response.headers['retry-after'] || 2;
        console.log(`Rate limited. Waiting ${retryAfter} seconds...`);
        await delay(retryAfter * 1000);
        retries--;
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries reached for Shopify API');
}

// Get all products from Shopify with pagination
async function getAllProducts() {
  console.log('Fetching products from Shopify...');
  let allProducts = [];
  let nextPageUrl = '/products.json?limit=250';
  
  while (nextPageUrl) {
    try {
      const response = await shopifyAPI.get(nextPageUrl);
      const data = response.data;
      allProducts = allProducts.concat(data.products);
      
      console.log(`Fetched ${allProducts.length} products so far...`);
      
      // Check for next page in Link header
      const linkHeader = response.headers.link;
      nextPageUrl = null;
      
      if (linkHeader) {
        const matches = linkHeader.match(/<([^>]+)>; rel="next"/);
        if (matches) {
          // Extract just the path and query from the full URL
          const fullUrl = matches[1];
          const url = new URL(fullUrl);
          // Remove the /admin/api/2024-10 prefix if it exists
          nextPageUrl = url.pathname.replace(/^\/admin\/api\/\d{4}-\d{2}/, '') + url.search;
        }
      }
      
      await delay(500); // Be nice to the API
    } catch (error) {
      console.error('Error fetching products:', error.message);
      throw error;
    }
  }
  
  console.log(`Fetched ${allProducts.length} products in total`);
  return allProducts;
}

// Get inventory levels for products
async function getInventoryLevels(inventoryItemIds) {
  if (!inventoryItemIds.length) return {};
  
  const inventoryLevels = {};
  
  // Shopify allows up to 50 inventory items per request
  for (let i = 0; i < inventoryItemIds.length; i += 50) {
    const batch = inventoryItemIds.slice(i, i + 50);
    const data = await shopifyAPICall('/inventory_levels.json', {
      inventory_item_ids: batch.join(',')
    });
    
    data.inventory_levels.forEach(level => {
      inventoryLevels[level.inventory_item_id] = level.available || 0;
    });
    
    await delay(500);
  }
  
  return inventoryLevels;
}

// Get recent orders from Shopify
async function getRecentOrders() {
  console.log('Fetching recent orders from Shopify...');
  
  // Get orders from the last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  let allOrders = [];
  let nextPageUrl = `/orders.json?limit=250&status=any&created_at_min=${thirtyDaysAgo.toISOString()}`;
  
  while (nextPageUrl) {
    try {
      const response = await shopifyAPI.get(nextPageUrl);
      const data = response.data;
      allOrders = allOrders.concat(data.orders);
      
      console.log(`Fetched ${allOrders.length} orders so far...`);
      
      // Check for next page in Link header
      const linkHeader = response.headers.link;
      nextPageUrl = null;
      
      if (linkHeader) {
        const matches = linkHeader.match(/<([^>]+)>; rel="next"/);
        if (matches) {
          // Extract just the path and query from the full URL
          const fullUrl = matches[1];
          const url = new URL(fullUrl);
          // Remove the /admin/api/2024-10 prefix if it exists
          nextPageUrl = url.pathname.replace(/^\/admin\/api\/\d{4}-\d{2}/, '') + url.search;
        }
      }
      
      await delay(500);
    } catch (error) {
      console.error('Error fetching orders:', error.message);
      throw error;
    }
  }
  
  console.log(`Fetched ${allOrders.length} orders in total`);
  return allOrders;
}

// Check if a product exists in Notion
async function findNotionProduct(shopifyProductId) {
  try {
    const response = await notion.databases.query({
      database_id: PRODUCTS_DATABASE_ID,
      filter: {
        property: 'Shopify Product ID',
        rich_text: {
          equals: shopifyProductId.toString()
        }
      }
    });
    
    return response.results[0] || null;
  } catch (error) {
    console.error('Error finding product in Notion:', error);
    return null;
  }
}

// Create or update product in Notion
async function syncProductToNotion(product, inventoryLevel) {
  const shopifyProductId = product.id.toString();
  const existingPage = await findNotionProduct(shopifyProductId);
  
  // Get the first variant's data
  const defaultVariant = product.variants?.[0] || {};
  
  const properties = {
    'Product Name': {
      title: [{
        text: { content: product.title || 'Untitled Product' }
      }]
    },
    'Shopify Product ID': {
      rich_text: [{
        text: { content: shopifyProductId }
      }]
    },
    'Description': {
      rich_text: [{
        text: { content: (product.body_html || '').replace(/<[^>]*>/g, '').substring(0, 2000) }
      }]
    },
    'Vendor': {
      select: product.vendor ? { name: product.vendor } : null
    },
    'Product Type': {
      select: product.product_type ? { name: product.product_type } : null
    },
    'Tags': {
      multi_select: product.tags ? product.tags.split(',').map(tag => ({ name: tag.trim() })) : []
    },
    'Image URL': {
      url: product.image?.src || null
    },
    'Product Handle': {
      rich_text: [{
        text: { content: product.handle || '' }
      }]
    },
    'Default Variant SKU': {
      rich_text: [{
        text: { content: defaultVariant.sku || '' }
      }]
    },
    'Default Variant Price': {
      number: parseFloat(defaultVariant.price) || 0
    },
    'Inventory Item ID': {
      rich_text: [{
        text: { content: defaultVariant.inventory_item_id?.toString() || '' }
      }]
    },
    'Current Stock': {
      number: inventoryLevel || 0
    },
    'Product URL': {
      url: `https://${SHOPIFY_STORE_NAME}.myshopify.com/products/${product.handle}`
    },
    'Last Synced At': {
      date: { start: new Date().toISOString() }
    }
  };
  
  try {
    if (existingPage) {
      // Update existing product
      await notion.pages.update({
        page_id: existingPage.id,
        properties
      });
      console.log(`Updated product: ${product.title}`);
    } else {
      // Create new product
      await notion.pages.create({
        parent: { database_id: PRODUCTS_DATABASE_ID },
        properties
      });
      console.log(`Created product: ${product.title}`);
    }
    
    await delay(350); // Respect Notion's rate limit (3 requests/second)
  } catch (error) {
    console.error(`Error syncing product ${product.title}:`, error.message);
  }
}

// Check if an order exists in Notion
async function findNotionOrder(shopifyOrderId) {
  try {
    const response = await notion.databases.query({
      database_id: ORDERS_DATABASE_ID,
      filter: {
        property: 'Order ID',
        title: {
          equals: shopifyOrderId.toString()
        }
      }
    });
    
    return response.results[0] || null;
  } catch (error) {
    console.error('Error finding order in Notion:', error);
    return null;
  }
}

// Create or update order in Notion
async function syncOrderToNotion(order) {
  const shopifyOrderId = order.id.toString();
  const existingPage = await findNotionOrder(shopifyOrderId);
  
  // Create products purchased summary
  const productsSummary = order.line_items.map(item => 
    `${item.quantity}x ${item.name}${item.sku ? ` (SKU: ${item.sku})` : ''}`
  ).join(', ');
  
  // Calculate total items
  const totalItems = order.line_items.reduce((sum, item) => sum + item.quantity, 0);
  
  const properties = {
    'Order ID': {
      title: [{
        text: { content: shopifyOrderId }
      }]
    },
    'Order Number': {
      number: order.order_number || 0
    },
    'Created At': {
      date: { start: order.created_at }
    },
    'Customer Email': {
      email: order.email || null
    },
    'Total Price': {
      number: parseFloat(order.total_price) || 0
    },
    'Products Purchased': {
      rich_text: [{
        text: { content: productsSummary.substring(0, 2000) }
      }]
    },
    'Total Items': {
      number: totalItems
    },
    'Last Synced At': {
      date: { start: new Date().toISOString() }
    }
  };
  
  try {
    if (existingPage) {
      // Update existing order
      await notion.pages.update({
        page_id: existingPage.id,
        properties
      });
      console.log(`Updated order: ${order.order_number}`);
    } else {
      // Create new order
      await notion.pages.create({
        parent: { database_id: ORDERS_DATABASE_ID },
        properties
      });
      console.log(`Created order: ${order.order_number}`);
    }
    
    await delay(350); // Respect Notion's rate limit
  } catch (error) {
    console.error(`Error syncing order ${order.order_number}:`, error.message);
  }
}

// Main sync function
async function syncShopifyToNotion() {
  console.log('Starting Shopify to Notion sync...');
  console.log(`Store: ${SHOPIFY_STORE_NAME}`);
  
  try {
    // Sync Products
    console.log('\n=== Syncing Products ===');
    const products = await getAllProducts();
    
    // Get all inventory item IDs
    const inventoryItemIds = products
      .flatMap(p => p.variants.map(v => v.inventory_item_id))
      .filter(id => id);
    
    // Get inventory levels
    console.log('Fetching inventory levels...');
    const inventoryLevels = await getInventoryLevels(inventoryItemIds);
    
    // Sync each product to Notion
    for (const product of products) {
      const defaultVariant = product.variants?.[0];
      const inventoryLevel = defaultVariant?.inventory_item_id 
        ? inventoryLevels[defaultVariant.inventory_item_id] 
        : 0;
      
      await syncProductToNotion(product, inventoryLevel);
    }
    
    // Sync Orders
    console.log('\n=== Syncing Orders ===');
    const orders = await getRecentOrders();
    
    for (const order of orders) {
      await syncOrderToNotion(order);
    }
    
    console.log('\n✅ Sync completed successfully!');
    
  } catch (error) {
    console.error('❌ Sync failed:', error);
    throw error;
  }
}

// Run the sync
if (require.main === module) {
  syncShopifyToNotion()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}
