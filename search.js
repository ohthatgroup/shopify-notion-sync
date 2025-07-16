const { Client } = require('@notionhq/client');
const axios = require('axios');
require('dotenv').config();

// Configuration
const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const PRODUCTS_DATABASE_ID = process.env.PRODUCTS_DATABASE_ID || '22ab2975e0b7804cbcdaf8b5e6b37d19';

// Initialize clients
const notion = new Client({ auth: NOTION_API_KEY });
const graphqlEndpoint = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-10/graphql.json`;

// GraphQL helper
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
      throw new Error('GraphQL query failed');
    }
    
    return response.data.data;
  } catch (error) {
    console.error('GraphQL error:', error);
    throw error;
  }
}

// Search products in Shopify
async function searchShopifyProducts(keyword) {
  console.log(`🔍 Searching Shopify for: "${keyword}"`);
  
  const SEARCH_QUERY = `
    query($query: String!) {
      products(first: 50, query: $query) {
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            tags
            status
            featuredImage {
              url
            }
            variants(first: 5) {
              edges {
                node {
                  sku
                  price
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }
  `;
  
  try {
    const response = await shopifyGraphQL(SEARCH_QUERY, { query: keyword });
    const products = response.products.edges.map(({ node }) => ({
      source: 'Shopify',
      id: node.id.split('/').pop(),
      title: node.title,
      type: node.productType,
      vendor: node.vendor,
      tags: node.tags,
      status: node.status,
      image: node.featuredImage?.url,
      url: `https://${SHOPIFY_STORE_NAME}.myshopify.com/products/${node.handle}`,
      variants: node.variants.edges.map(v => v.node),
      matchedOn: determineMatchField(node, keyword)
    }));
    
    console.log(`✅ Found ${products.length} products in Shopify`);
    return products;
  } catch (error) {
    console.error('Shopify search error:', error);
    return [];
  }
}

// Determine what field matched the search
function determineMatchField(product, keyword) {
  const lowerKeyword = keyword.toLowerCase();
  
  if (product.title?.toLowerCase().includes(lowerKeyword)) return 'title';
  if (product.vendor?.toLowerCase().includes(lowerKeyword)) return 'vendor';
  if (product.productType?.toLowerCase().includes(lowerKeyword)) return 'type';
  if (product.tags?.some(tag => tag.toLowerCase().includes(lowerKeyword))) return 'tags';
  if (product.variants?.edges?.some(v => v.node.sku?.toLowerCase().includes(lowerKeyword))) return 'sku';
  
  return 'unknown';
}

// Search products in Notion
async function searchNotionProducts(keyword) {
  console.log(`🔍 Searching Notion for: "${keyword}"`);
  
  try {
    const response = await notion.databases.query({
      database_id: PRODUCTS_DATABASE_ID,
      filter: {
        or: [
          {
            property: 'Product Name',
            title: { contains: keyword }
          },
          {
            property: 'Description',
            rich_text: { contains: keyword }
          },
          {
            property: 'Tags',
            multi_select: { contains: keyword }
          },
          {
            property: 'Vendor',
            select: { equals: keyword }
          },
          {
            property: 'Product Type',
            select: { equals: keyword }
          },
          {
            property: 'Default Variant SKU',
            rich_text: { contains: keyword }
          },
          {
            property: 'Product Handle',
            rich_text: { contains: keyword }
          }
        ]
      },
      page_size: 100
    });
    
    const products = response.results.map(page => {
      const props = page.properties;
      return {
        source: 'Notion',
        id: props['Shopify Product ID']?.rich_text[0]?.text?.content || page.id,
        title: props['Product Name']?.title[0]?.text?.content || 'Untitled',
        type: props['Product Type']?.select?.name,
        vendor: props['Vendor']?.select?.name,
        tags: props['Tags']?.multi_select?.map(tag => tag.name) || [],
        sku: props['Default Variant SKU']?.rich_text[0]?.text?.content,
        price: props['Default Variant Price']?.number,
        stock: props['Current Stock']?.number,
        image: props['Image URL']?.url,
        url: props['Product URL']?.url,
        notionUrl: page.url,
        lastSynced: props['Last Synced At']?.date?.start,
        matchedOn: 'notion_search'
      };
    });
    
    console.log(`✅ Found ${products.length} products in Notion`);
    return products;
  } catch (error) {
    console.error('Notion search error:', error);
    return [];
  }
}

// Search by collection
async function searchByCollection(collectionHandle) {
  console.log(`🔍 Searching for collection: "${collectionHandle}"`);
  
  const COLLECTION_QUERY = `
    query($handle: String!) {
      collectionByHandle(handle: $handle) {
        id
        title
        description
        productsCount
        products(first: 250) {
          edges {
            node {
              id
              title
              handle
              vendor
              productType
              featuredImage {
                url
              }
              variants(first: 1) {
                edges {
                  node {
                    price
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  
  try {
    const response = await shopifyGraphQL(COLLECTION_QUERY, { handle: collectionHandle });
    
    if (!response.collectionByHandle) {
      console.log('Collection not found');
      return [];
    }
    
    const collection = response.collectionByHandle;
    console.log(`✅ Found collection: ${collection.title} (${collection.productsCount} products)`);
    
    return collection.products.edges.map(({ node }) => ({
      source: 'Shopify Collection',
      collection: collection.title,
      id: node.id.split('/').pop(),
      title: node.title,
      vendor: node.vendor,
      type: node.productType,
      image: node.featuredImage?.url,
      url: `https://${SHOPIFY_STORE_NAME}.myshopify.com/products/${node.handle}`,
      price: node.variants.edges[0]?.node?.price,
      stock: node.variants.edges[0]?.node?.inventoryQuantity
    }));
  } catch (error) {
    console.error('Collection search error:', error);
    return [];
  }
}

// Unified search function
async function unifiedSearch(keyword, options = {}) {
  console.log(`\n🚀 Starting unified search for: "${keyword}"`);
  console.log(`Options:`, options);
  
  const results = {
    keyword,
    timestamp: new Date().toISOString(),
    shopify: [],
    notion: [],
    collection: [],
    summary: {}
  };
  
  try {
    // Parallel searches
    const [shopifyResults, notionResults] = await Promise.all([
      options.skipShopify ? [] : searchShopifyProducts(keyword),
      options.skipNotion ? [] : searchNotionProducts(keyword)
    ]);
    
    results.shopify = shopifyResults;
    results.notion = notionResults;
    
    // If keyword looks like a collection handle, search collections too
    if (keyword.match(/^[a-z0-9-]+$/) && !options.skipCollections) {
      results.collection = await searchByCollection(keyword);
    }
    
    // Generate summary
    results.summary = {
      totalResults: results.shopify.length + results.notion.length + results.collection.length,
      shopifyCount: results.shopify.length,
      notionCount: results.notion.length,
      collectionCount: results.collection.length,
      sources: {
        shopify: results.shopify.length > 0,
        notion: results.notion.length > 0,
        collection: results.collection.length > 0
      }
    };
    
    // Find products that exist in both systems
    const shopifyIds = new Set(results.shopify.map(p => p.id));
    const notionIds = new Set(results.notion.map(p => p.id));
    const inBothSystems = [...shopifyIds].filter(id => notionIds.has(id));
    
    results.summary.syncStatus = {
      inBoth: inBothSystems.length,
      shopifyOnly: results.shopify.length - inBothSystems.length,
      notionOnly: results.notion.length - inBothSystems.length
    };
    
    return results;
    
  } catch (error) {
    console.error('Search error:', error);
    results.error = error.message;
    return results;
  }
}

// Format results for display
function displayResults(results) {
  console.log('\n' + '='.repeat(60));
  console.log(`SEARCH RESULTS FOR: "${results.keyword}"`);
  console.log('='.repeat(60));
  
  console.log(`\n📊 SUMMARY:`);
  console.log(`Total Results: ${results.summary.totalResults}`);
  console.log(`├─ Shopify: ${results.summary.shopifyCount}`);
  console.log(`├─ Notion: ${results.summary.notionCount}`);
  console.log(`└─ Collections: ${results.summary.collectionCount}`);
  
  if (results.summary.syncStatus) {
    console.log(`\n🔄 SYNC STATUS:`);
    console.log(`├─ In Both Systems: ${results.summary.syncStatus.inBoth}`);
    console.log(`├─ Shopify Only: ${results.summary.syncStatus.shopifyOnly}`);
    console.log(`└─ Notion Only: ${results.summary.syncStatus.notionOnly}`);
  }
  
  // Shopify Results
  if (results.shopify.length > 0) {
    console.log(`\n📦 SHOPIFY PRODUCTS (${results.shopify.length}):`);
    results.shopify.forEach((product, i) => {
      console.log(`\n${i + 1}. ${product.title}`);
      console.log(`   ID: ${product.id} | Matched on: ${product.matchedOn}`);
      console.log(`   Type: ${product.type || 'N/A'} | Vendor: ${product.vendor || 'N/A'}`);
      console.log(`   Tags: ${product.tags?.join(', ') || 'None'}`);
      console.log(`   URL: ${product.url}`);
    });
  }
  
  // Notion Results
  if (results.notion.length > 0) {
    console.log(`\n📝 NOTION PRODUCTS (${results.notion.length}):`);
    results.notion.forEach((product, i) => {
      console.log(`\n${i + 1}. ${product.title}`);
      console.log(`   ID: ${product.id} | SKU: ${product.sku || 'N/A'}`);
      console.log(`   Price: $${product.price || 0} | Stock: ${product.stock || 0}`);
      console.log(`   Last Synced: ${product.lastSynced ? new Date(product.lastSynced).toLocaleString() : 'Never'}`);
    });
  }
  
  // Collection Results
  if (results.collection.length > 0) {
    console.log(`\n🏷️ COLLECTION PRODUCTS (${results.collection.length}):`);
    console.log(`Collection: ${results.collection[0].collection}`);
    results.collection.slice(0, 10).forEach((product, i) => {
      console.log(`${i + 1}. ${product.title} - $${product.price || 0}`);
    });
    if (results.collection.length > 10) {
      console.log(`... and ${results.collection.length - 10} more`);
    }
  }
  
  console.log('\n' + '='.repeat(60));
}

// Export results to JSON
async function exportResults(results, filename = null) {
  const fs = require('fs').promises;
  const exportFilename = filename || `search-results-${Date.now()}.json`;
  
  await fs.writeFile(exportFilename, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results exported to: ${exportFilename}`);
}

// Main CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
🔍 Shopify-Notion Search Tool

Usage:
  node search.js <keyword> [options]

Options:
  --shopify-only    Search only in Shopify
  --notion-only     Search only in Notion
  --export          Export results to JSON file
  --export=filename Export results to specific file

Examples:
  node search.js "blue shirt"
  node search.js "summer-collection" --export
  node search.js "SKU123" --notion-only
    `);
    process.exit(0);
  }
  
  const keyword = args[0];
  const options = {
    skipShopify: args.includes('--notion-only'),
    skipNotion: args.includes('--shopify-only'),
    skipCollections: false
  };
  
  // Run search
  const results = await unifiedSearch(keyword, options);
  
  // Display results
  displayResults(results);
  
  // Export if requested
  if (args.some(arg => arg.startsWith('--export'))) {
    const exportArg = args.find(arg => arg.startsWith('--export='));
    const filename = exportArg ? exportArg.split('=')[1] : null;
    await exportResults(results, filename);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

// Export for use in other scripts
module.exports = {
  unifiedSearch,
  searchShopifyProducts,
  searchNotionProducts,
  searchByCollection
};
