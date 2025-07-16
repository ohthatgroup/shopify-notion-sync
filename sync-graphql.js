const { Client } = require('@notionhq/client');
const axios = require('axios');
const { format } = require('date-fns');

// Load environment variables
require('dotenv').config();

// Configuration
const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const PRODUCTS_DATABASE_ID = process.env.PRODUCTS_DATABASE_ID || '22ab2975e0b7804cbcdaf8b5e6b37d19';

// Initialize Notion client
const notion = new Client({ auth: NOTION_API_KEY });

// GraphQL endpoint
const graphqlEndpoint = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-10/graphql.json`;

// Helper function for delays
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// GraphQL request with cost monitoring
async function shopifyGraphQL(query, variables = {}) {
  try {
    const response = await axios.post(
      graphqlEndpoint,
      { query, variables },
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.data.errors) {
      console.error('GraphQL Errors:', JSON.stringify(response.data.errors, null, 2));
      throw new Error('GraphQL query failed');
    }
    
    // Monitor query cost
    if (response.data.extensions?.cost) {
      const { actualQueryCost, throttleStatus } = response.data.extensions.cost;
      const { currentlyAvailable, restoreRate } = throttleStatus;
      
      console.log(`Query cost: ${actualQueryCost}, Available points: ${currentlyAvailable}`);
      
      // Dynamic delay based on available points
      if (currentlyAvailable < 500) {
        const waitTime = Math.max(100, (500 - currentlyAvailable) / restoreRate * 1000);
        console.log(`Rate limit approaching, waiting ${waitTime}ms...`);
        await delay(waitTime);
      }
    }
    
    return response.data;
  } catch (error) {
    if (error.response?.status === 429) {
      console.log('Rate limited! Waiting 2 seconds...');
      await delay(2000);
      return shopifyGraphQL(query, variables); // Retry
    }
    throw error;
  }
}

// Fetch all products with GraphQL
async function fetchAllProducts() {
  console.log('Fetching products from Shopify (GraphQL)...');
  
  const PRODUCTS_QUERY = `
    query($cursor: String) {
      products(first: 250, after: $cursor) {
        edges {
          node {
            id
            title
            handle
            descriptionHtml
            vendor
            productType
            tags
            status
            createdAt
            updatedAt
            featuredImage {
              url
              altText
            }
            images(first: 5) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  price
                  compareAtPrice
                  availableForSale
                  inventoryQuantity
                  inventoryItem {
                    id
                    tracked
                    inventoryLevels(first: 10) {
                      edges {
                        node {
                          available
                          location {
                            name
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            collections(first: 10) {
              edges {
                node {
                  title
                  handle
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  
  while (hasNextPage) {
    const response = await shopifyGraphQL(PRODUCTS_QUERY, cursor ? { cursor } : {});
    const products = response.data.products.edges.map(edge => edge.node);
    
    allProducts = allProducts.concat(products);
    
    hasNextPage = response.data.products.pageInfo.hasNextPage;
    cursor = response.data.products.pageInfo.endCursor;
    
    console.log(`Fetched ${allProducts.length} products so far...`);
  }
  
  console.log(`Total products fetched: ${allProducts.length}`);
  return allProducts;
}

// Find product in Notion by Shopify ID
async function findNotionProduct(shopifyProductId) {
  try {
    // Extract numeric ID from GraphQL ID (e.g., "gid://shopify/Product/123456" -> "123456")
    const numericId = shopifyProductId.split('/').pop();
    
    const response = await notion.databases.query({
      database_id: PRODUCTS_DATABASE_ID,
      filter: {
        property: 'Shopify Product ID',
        rich_text: {
          equals: numericId
        }
      }
    });
    
    return response.results[0] || null;
  } catch (error) {
    console.error('Error finding product in Notion:', error);
    return null;
  }
}

// Calculate total inventory across all locations
function calculateTotalInventory(variants) {
  let totalInventory = 0;
  
  variants.edges.forEach(({ node: variant }) => {
    if (variant.inventoryItem && variant.inventoryItem.inventoryLevels) {
      variant.inventoryItem.inventoryLevels.edges.forEach(({ node: level }) => {
        totalInventory += level.available || 0;
      });
    }
  });
  
  return totalInventory;
}

// Sync product to Notion
async function syncProductToNotion(product) {
  const numericId = product.id.split('/').pop();
  const existingPage = await findNotionProduct(product.id);
  
  // Get the default (first) variant
  const defaultVariant = product.variants.edges[0]?.node || {};
  
  // Calculate total inventory
  const totalInventory = calculateTotalInventory(product.variants);
  
  // Get collections
  const collections = product.collections.edges
    .map(({ node }) => node.title)
    .join(', ');
  
  // Build properties object
  const properties = {
    'Product Name': {
      title: [{
        text: { content: product.title || 'Untitled Product' }
      }]
    },
    'Shopify Product ID': {
      rich_text: [{
        text: { content: numericId }
      }]
    },
    'Description': {
      rich_text: [{
        text: { 
          content: (product.descriptionHtml || '')
            .replace(/<[^>]*>/g, '')
            .substring(0, 2000) 
        }
      }]
    },
    'Vendor': {
      select: product.vendor ? { name: product.vendor.substring(0, 100) } : null
    },
    'Product Type': {
      select: product.productType ? { name: product.productType.substring(0, 100) } : null
    },
    'Tags': {
      multi_select: product.tags ? 
        product.tags.slice(0, 100).map(tag => ({ name: tag.trim().substring(0, 100) })) : 
        []
    },
    'Image URL': {
      url: product.featuredImage?.url || null
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
    'Compare At Price': {
      number: defaultVariant.compareAtPrice ? parseFloat(defaultVariant.compareAtPrice) : null
    },
    'Inventory Item ID': {
      rich_text: [{
        text: { content: defaultVariant.inventoryItem?.id?.split('/').pop() || '' }
      }]
    },
    'Current Stock': {
      number: totalInventory
    },
    'Total Variants': {
      number: product.variants.edges.length
    },
    'Collections': {
      rich_text: [{
        text: { content: collections.substring(0, 2000) }
      }]
    },
    'Product URL': {
      url: `https://${SHOPIFY_STORE_NAME}.myshopify.com/products/${product.handle}`
    },
    'Last Synced At': {
      date: { start: new Date().toISOString() }
    }
  };
  
  // Add status if available
  if (product.status) {
    properties['Status'] = {
      select: { name: product.status }
    };
  }
  
  try {
    if (existingPage) {
      // Update existing product
      await notion.pages.update({
        page_id: existingPage.id,
        properties
      });
      console.log(`✅ Updated: ${product.title}`);
    } else {
      // Create new product
      await notion.pages.create({
        parent: { database_id: PRODUCTS_DATABASE_ID },
        properties
      });
      console.log(`✅ Created: ${product.title}`);
    }
    
    await delay(350); // Respect Notion's rate limit
  } catch (error) {
    console.error(`❌ Error syncing ${product.title}:`, error.message);
  }
}

// Main sync function
async function syncShopifyToNotion() {
  console.log('🚀 Starting Shopify to Notion GraphQL sync...');
  console.log(`📍 Store: ${SHOPIFY_STORE_NAME}`);
  console.log(`📊 Using GraphQL API (future-proof!)\n`);
  
  try {
    // Fetch all products
    const products = await fetchAllProducts();
    
    console.log(`\n📦 Syncing ${products.length} products to Notion...\n`);
    
    // Sync each product
    let synced = 0;
    for (const product of products) {
      await syncProductToNotion(product);
      synced++;
      
      // Progress update every 10 products
      if (synced % 10 === 0) {
        console.log(`Progress: ${synced}/${products.length} products synced...`);
      }
    }
    
    console.log('\n✨ Sync completed successfully!');
    console.log(`📊 Summary: ${synced} products synced`);
    
  } catch (error) {
    console.error('❌ Sync failed:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  syncShopifyToNotion()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { syncShopifyToNotion, fetchAllProducts };
