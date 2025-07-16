# Shopify-Notion Sync & Search

A powerful GraphQL-powered sync system between Shopify and Notion with keyword search capabilities.

## 🚀 Features

- **GraphQL-Powered Sync**: Future-proof integration using Shopify's modern GraphQL API
- **Keyword Search**: Search across both Shopify and Notion databases
- **Collection Search**: Find all products in a specific Shopify collection
- **Automated Sync**: GitHub Actions scheduled sync (daily at 2 AM UTC)
- **Inventory Tracking**: Real-time inventory levels across all locations
- **Smart Rate Limiting**: Cost-aware GraphQL queries with dynamic delays

## 📦 What Gets Synced

- Product names, descriptions, and handles
- Vendor and product type
- Tags and collections
- Pricing (including compare-at prices)
- SKUs and barcodes
- Inventory levels (all locations)
- Product images
- Total variant count
- Last sync timestamp

## 🔍 Search Capabilities

Search by:
- Product name
- SKU
- Tags
- Vendor
- Product type
- Collection handle
- Description content

## 🛠️ Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd shopify-notion-sync
   npm install
