const { Client } = require('@notionhq/client');
const axios = require('axios');
const { format, startOfDay, endOfDay, subDays } = require('date-fns');

// Configuration
const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const NOTION_API_KEY = process.env.NOTION_API_KEY;

// Your Analytics Database ID (you'll need to create this)
const ANALYTICS_DATABASE_ID = 'YOUR_ANALYTICS_DATABASE_ID'; // Replace this!

// Initialize clients
const notion = new Client({ auth: NOTION_API_KEY });
const graphqlEndpoint = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-10/graphql.json`;

// Helper function to make GraphQL requests
async function shopifyGraphQL(query, variables = {}) {
  try {
    const response = await axios.post(
      graphqlEndpoint,
      { 
        query,
        variables 
      },
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
    
    return response.data.data;
  } catch (error) {
    console.error('GraphQL Request failed:', error);
    throw error;
  }
}

// Fetch all orders for a date range with CORRECT query syntax
async function fetchAllOrders(startDate, endDate) {
  console.log(`Fetching orders from ${startDate} to ${endDate}...`);
  
  let allOrders = [];
  let hasNextPage = true;
  let cursor = null;
  
  // Format dates for Shopify query
  const formattedStartDate = format(new Date(startDate), 'yyyy-MM-dd');
  const formattedEndDate = format(new Date(endDate), 'yyyy-MM-dd');
  
  while (hasNextPage) {
    const query = `
      query($cursor: String) {
        orders(
          first: 250
          after: $cursor
          query: "created_at:>='${formattedStartDate}' AND created_at:<='${formattedEndDate}'"
        ) {
          edges {
            node {
              id
              name
              createdAt
              cancelledAt
              customer {
                id
                email
                ordersCount
              }
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              currentTotalPriceSet {
                shopMoney {
                  amount
                }
              }
              refunds {
                id
              }
              lineItems(first: 100) {
                edges {
                  node {
                    quantity
                    title
                    sku
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
    `;
    
    const variables = cursor ? { cursor } : {};
    const response = await shopifyGraphQL(query, variables);
    
    const orders = response.orders.edges.map(edge => edge.node);
    allOrders = allOrders.concat(orders);
    
    hasNextPage = response.orders.pageInfo.hasNextPage;
    cursor = response.orders.pageInfo.endCursor;
    
    console.log(`Fetched ${allOrders.length} orders so far...`);
    
    // Rate limit protection
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return allOrders;
}

// Calculate comprehensive analytics
function calculateAnalytics(orders) {
  console.log('Calculating analytics...');
  
  // Initialize metrics
  const metrics = {
    // Core Performance
    totalOrders: orders.length,
    totalSales: 0,
    netSales: 0,
    totalRefunds: 0,
    cancelledOrders: 0,
    
    // Items
    totalItemsSold: 0,
    uniqueProducts: new Set(),
    
    // Customers
    uniqueCustomers: new Set(),
    customerOrderMap: new Map(),
    firstTimeCustomers: 0,
    returningCustomers: 0,
    
    // Product performance
    productSales: new Map(),
    
    // Time-based
    ordersByDate: new Map(),
  };
  
  // Process each order
  orders.forEach(order => {
    // Skip cancelled orders for sales metrics
    if (order.cancelledAt) {
      metrics.cancelledOrders++;
      return;
    }
    
    // Sales metrics
    const orderAmount = parseFloat(order.totalPriceSet.shopMoney.amount);
    const currentAmount = parseFloat(order.currentTotalPriceSet.shopMoney.amount);
    
    metrics.totalSales += orderAmount;
    metrics.netSales += currentAmount;
    
    if (order.refunds && order.refunds.length > 0) {
      metrics.totalRefunds += (orderAmount - currentAmount);
    }
    
    // Customer metrics
    if (order.customer) {
      const customerId = order.customer.id;
      const customerEmail = order.customer.email;
      
      metrics.uniqueCustomers.add(customerId);
      
      // Track customer orders
      if (!metrics.customerOrderMap.has(customerId)) {
        metrics.customerOrderMap.set(customerId, {
          email: customerEmail,
          orders: [],
          totalSpent: 0,
          ordersCount: order.customer.ordersCount || 1
        });
      }
      
      const customerData = metrics.customerOrderMap.get(customerId);
      customerData.orders.push(order);
      customerData.totalSpent += currentAmount;
      
      // First-time vs returning (based on ordersCount at time of order)
      if (order.customer.ordersCount === 1) {
        metrics.firstTimeCustomers++;
      }
    }
    
    // Items metrics
    order.lineItems.edges.forEach(({ node: item }) => {
      metrics.totalItemsSold += item.quantity;
      metrics.uniqueProducts.add(item.title);
      
      // Track product performance
      const productKey = item.title;
      if (!metrics.productSales.has(productKey)) {
        metrics.productSales.set(productKey, {
          name: item.title,
          sku: item.sku,
          quantity: 0,
          revenue: 0
        });
      }
      
      const product = metrics.productSales.get(productKey);
      product.quantity += item.quantity;
      product.revenue += item.quantity * (parseFloat(item.variant?.price || 0));
    });
    
    // Date-based tracking
    const orderDate = format(new Date(order.createdAt), 'yyyy-MM-dd');
    if (!metrics.ordersByDate.has(orderDate)) {
      metrics.ordersByDate.set(orderDate, {
        orders: 0,
        revenue: 0,
        items: 0
      });
    }
    
    const dateMetrics = metrics.ordersByDate.get(orderDate);
    dateMetrics.orders++;
    dateMetrics.revenue += currentAmount;
    dateMetrics.items += order.lineItems.edges.reduce((sum, { node }) => sum + node.quantity, 0);
  });
  
  // Calculate returning customers based on those who have more than 1 order
  let returningCustomersCount = 0;
  let totalReturnCustomerOrders = 0;
  
  metrics.customerOrderMap.forEach((customer) => {
    if (customer.ordersCount > 1) {
      returningCustomersCount++;
      totalReturnCustomerOrders += customer.orders.length;
    }
  });
  
  // Calculate derived metrics
  const validOrders = metrics.totalOrders - metrics.cancelledOrders;
  const avgOrderValue = validOrders > 0 ? metrics.netSales / validOrders : 0;
  const avgItemsPerOrder = validOrders > 0 ? metrics.totalItemsSold / validOrders : 0;
  const avgOrdersPerCustomer = metrics.uniqueCustomers.size > 0 ? validOrders / metrics.uniqueCustomers.size : 0;
  
  const avgOrdersPerReturningCustomer = returningCustomersCount > 0 
    ? totalReturnCustomerOrders / returningCustomersCount 
    : 0;
  
  const customerRetentionRate = metrics.uniqueCustomers.size > 0
    ? (returningCustomersCount / metrics.uniqueCustomers.size) * 100
    : 0;
  
  // Top products
  const topProductsByQuantity = Array.from(metrics.productSales.values())
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 10);
  
  const topProductsByRevenue = Array.from(metrics.productSales.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);
  
  return {
    // Core Performance Metrics
    totalSales: metrics.totalSales.toFixed(2),
    netSales: metrics.netSales.toFixed(2),
    totalRefunds: metrics.totalRefunds.toFixed(2),
    totalOrders: metrics.totalOrders,
    validOrders: validOrders,
    cancelledOrders: metrics.cancelledOrders,
    uniqueCustomers: metrics.uniqueCustomers.size,
    avgOrderValue: avgOrderValue.toFixed(2),
    totalItemsSold: metrics.totalItemsSold,
    avgItemsPerOrder: avgItemsPerOrder.toFixed(1),
    uniqueProducts: metrics.uniqueProducts.size,
    
    // Customer Behavior
    firstTimeOrders: metrics.firstTimeCustomers,
    firstTimeOrdersPercent: metrics.uniqueCustomers.size > 0 
      ? ((metrics.firstTimeCustomers / metrics.uniqueCustomers.size) * 100).toFixed(1)
      : '0.0',
    returningCustomers: returningCustomersCount,
    returningOrders: totalReturnCustomerOrders,
    returningOrdersPercent: validOrders > 0
      ? ((totalReturnCustomerOrders / validOrders) * 100).toFixed(1)
      : '0.0',
    avgOrdersPerCustomer: avgOrdersPerCustomer.toFixed(2),
    avgOrdersPerReturningCustomer: avgOrdersPerReturningCustomer.toFixed(2),
    customerRetentionRate: customerRetentionRate.toFixed(1),
    
    // Top Products
    topProductsByQuantity: topProductsByQuantity.map(p => `${p.name} (${p.quantity} units)`).join(', '),
    topProductsByRevenue: topProductsByRevenue.map(p => `${p.name} ($${p.revenue.toFixed(2)})`).join(', '),
    
    // Time series data
    ordersByDate: metrics.ordersByDate,
    
    // Raw data for further analysis
    productSales: metrics.productSales,
    customerOrderMap: metrics.customerOrderMap
  };
}

// Save analytics to Notion
async function saveAnalyticsToNotion(analytics, periodStart, periodEnd) {
  console.log('Saving analytics to Notion...');
  
  const properties = {
    'Period': {
      title: [{
        text: { content: `${format(periodStart, 'MMM d')} - ${format(periodEnd, 'MMM d, yyyy')}` }
      }]
    },
    'Total Sales': {
      number: parseFloat(analytics.totalSales)
    },
    'Net Sales': {
      number: parseFloat(analytics.netSales)
    },
    'Total Orders': {
      number: analytics.validOrders
    },
    'Unique Customers': {
      number: analytics.uniqueCustomers
    },
    'Average Order Value': {
      number: parseFloat(analytics.avgOrderValue)
    },
    'Items Sold': {
      number: analytics.totalItemsSold
    },
    'Items per Order': {
      number: parseFloat(analytics.avgItemsPerOrder)
    },
    'First-time Orders': {
      number: analytics.firstTimeOrders
    },
    'First-time %': {
      number: parseFloat(analytics.firstTimeOrdersPercent)
    },
    'Returning Customers': {
      number: analytics.returningCustomers
    },
    'Returning Orders': {
      number: analytics.returningOrders
    },
    'Returning %': {
      number: parseFloat(analytics.returningOrdersPercent)
    },
    'Avg Orders/Customer': {
      number: parseFloat(analytics.avgOrdersPerCustomer)
    },
    'Avg Orders/Returning': {
      number: parseFloat(analytics.avgOrdersPerReturningCustomer)
    },
    'Retention Rate %': {
      number: parseFloat(analytics.customerRetentionRate)
    },
    'Top Products (Qty)': {
      rich_text: [{
        text: { content: analytics.topProductsByQuantity.substring(0, 2000) }
      }]
    },
    'Top Products (Revenue)': {
      rich_text: [{
        text: { content: analytics.topProductsByRevenue.substring(0, 2000) }
      }]
    },
    'Report Date': {
      date: { start: new Date().toISOString() }
    }
  };
  
  try {
    const response = await notion.pages.create({
      parent: { database_id: ANALYTICS_DATABASE_ID },
      properties
    });
    
    console.log('✅ Analytics saved to Notion successfully!');
    return response;
  } catch (error) {
    console.error('Error saving to Notion:', error);
    throw error;
  }
}

// Main function
async function runAnalytics() {
  console.log('🚀 Starting Shopify Analytics Sync');
  console.log(`Store: ${SHOPIFY_STORE_NAME}`);
  
  try {
    // Define analysis period (last 30 days)
    const endDate = endOfDay(new Date());
    const startDate = startOfDay(subDays(endDate, 30));
    
    console.log(`Analysis Period: ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}`);
    
    // Fetch all orders
    const orders = await fetchAllOrders(startDate, endDate);
    
    console.log(`Total orders fetched: ${orders.length}`);
    
    // Calculate analytics
    const analytics = calculateAnalytics(orders);
    
    // Display summary
    console.log('\n📊 ANALYTICS SUMMARY:');
    console.log('====================');
    console.log(`Total Sales: $${analytics.totalSales}`);
    console.log(`Net Sales: $${analytics.netSales}`);
    console.log(`Total Orders: ${analytics.validOrders}`);
    console.log(`Unique Customers: ${analytics.uniqueCustomers}`);
    console.log(`Average Order Value: $${analytics.avgOrderValue}`);
    console.log(`Items Sold: ${analytics.totalItemsSold}`);
    console.log(`Items per Order: ${analytics.avgItemsPerOrder}`);
    console.log('\nCUSTOMER BEHAVIOR:');
    console.log(`First-time Orders: ${analytics.firstTimeOrders} (${analytics.firstTimeOrdersPercent}%)`);
    console.log(`Returning Customers: ${analytics.returningCustomers}`);
    console.log(`Returning Orders: ${analytics.returningOrders} (${analytics.returningOrdersPercent}%)`);
    console.log(`Customer Retention: ${analytics.customerRetentionRate}%`);
    
    // Save to Notion
    await saveAnalyticsToNotion(analytics, startDate, endDate);
    
    console.log('\n✅ Analytics sync completed successfully!');
    
  } catch (error) {
    console.error('❌ Analytics sync failed:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  runAnalytics()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}
