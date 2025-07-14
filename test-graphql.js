const axios = require('axios');

// Configuration
const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// GraphQL endpoint
const graphqlEndpoint = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-10/graphql.json`;

// Test queries
const queries = {
  // 1. Basic shop info
  shopInfo: `
    query {
      shop {
        name
        email
        currencyCode
        productCount
      }
    }
  `,
  
  // 2. Sales summary for last 30 days
  salesSummary: `
    query {
      orders(first: 250, query: "created_at:>='${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}'") {
        edges {
          node {
            id
            createdAt
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  variant {
                    price
                  }
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
  `,
  
  // 3. Top selling products
  topProducts: `
    query {
      products(first: 10, sortKey: BEST_SELLING) {
        edges {
          node {
            title
            totalInventory
            priceRangeV2 {
              minVariantPrice {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  `,
  
  // 4. Inventory levels
  inventoryLevels: `
    query {
      locations(first: 10) {
        edges {
          node {
            name
            inventoryLevels(first: 10) {
              edges {
                node {
                  available
                  item {
                    variant {
                      product {
                        title
                      }
                      displayName
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `
};

// Helper function to make GraphQL request
async function makeGraphQLRequest(query, queryName) {
  try {
    console.log(`\n=== Testing ${queryName} ===`);
    
    const response = await axios.post(
      graphqlEndpoint,
      { query },
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.data.errors) {
      console.error(`❌ GraphQL Errors:`, JSON.stringify(response.data.errors, null, 2));
    } else {
      console.log(`✅ Success! Data received:`);
      console.log(JSON.stringify(response.data.data, null, 2));
    }
    
    return response.data;
  } catch (error) {
    console.error(`❌ Request failed for ${queryName}:`, error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    return null;
  }
}

// Run all tests
async function runTests() {
  console.log('🚀 Testing Shopify GraphQL API Access');
  console.log(`Store: ${SHOPIFY_STORE_NAME}`);
  console.log(`Endpoint: ${graphqlEndpoint}`);
  
  // Test each query
  for (const [queryName, query] of Object.entries(queries)) {
    await makeGraphQLRequest(query, queryName);
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n✅ All tests completed!');
}

// Run if called directly
if (require.main === module) {
  runTests().catch(console.error);
}
