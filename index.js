const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
// const sqlite3 = require('sqlite3').verbose();
// const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const app = express();
const axios = require('axios');
const https = require('https');

const multer = require('multer');
const FormData = require('form-data');


const API_BASE_URL = 'https://eljin.org/api';

// HTTPS agent to bypass SSL certificate validation for development/staging
// WARNING: This should NOT be used in production - fix SSL certificates instead
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});


const upload = multer({
  storage: multer.memoryStorage(), // Use memory instead of disk
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    fieldSize: 10 * 1024 * 1024
  }
});
// Configure body-parser to handle JSON with increased size limit
app.use(bodyParser.json({limit: '10mb'}));
app.use(bodyParser.urlencoded({extended: true, limit: '10mb'}));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  console.log('Received request:', {
    method: req.method,
    url: req.url,
    contentType: req.headers['content-type'],
    bodyLength: req.body ? JSON.stringify(req.body).length : 0
  });
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error processing request:', err);
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ 
      error: 'Invalid JSON format',
      details: err.message 
    });
  }
  next(err);
});

// API Base URL




// SQLite Database Setup
const DB_PATH = path.join(__dirname, 'ecpos_data.db');

// Ensure the database directory exists
const dbDirectory = path.dirname(DB_PATH);
if (!fs.existsSync(dbDirectory)) {
  fs.mkdirSync(dbDirectory, { recursive: true });
}

// Database initialization function
// Database initialization function for attendance only
// In-memory attendance storage for Vercel
let attendanceRecords = [];
let db = null; 

// Simple in-memory database functions
const memoryDB = {
  async run(query, params = []) {
    console.log('DB operation:', query, params);
    
    if (query.includes('attendance_records') && query.includes('INSERT')) {
      // Handle attendance insert
      const [staffId, storeId, date, timeIn, timeOut, breakIn, breakOut, status] = params;
      const record = {
        id: Date.now(),
        staffId,
        storeId, 
        date,
        timeIn,
        timeOut,
        breakIn,
        breakOut,
        status: status || 'ACTIVE',
        synced: 0,
        created_at: new Date().toISOString()
      };
      
      // Check if record exists
      const existingIndex = attendanceRecords.findIndex(r => r.staffId === staffId && r.date === date);
      if (existingIndex !== -1) {
        attendanceRecords[existingIndex] = { ...attendanceRecords[existingIndex], ...record };
      } else {
        attendanceRecords.push(record);
      }
    }
    
    return { changes: 1 };
  },
  
  async get(query, params = []) {
    if (query.includes('attendance_records')) {
      const [staffId, date] = params;
      return attendanceRecords.find(r => r.staffId === staffId && r.date === date) || null;
    }
    return null;
  },
  
  async all(query, params = []) {
    if (query.includes('attendance_records')) {
      return attendanceRecords.filter(r => r.synced === 0);
    }
    // Return empty array for other tables to prevent errors
    return [];
  }
};
// Replace the entire initializeDatabase function:
async function initializeDatabase() {
  try {
    console.log('Using in-memory storage for Vercel compatibility');
    db = memoryDB; // Assign memory DB to existing db variable
    console.log('In-memory database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}
// Initialize the database
initializeDatabase().catch(console.error);
// Initialize database for local development
if (process.env.NODE_ENV !== 'production') {
  initializeDatabase().catch(console.error);
}
// Helper function for decimal formatting
function formatDecimal(value) {
  if (value === undefined || value === null || value === '') {
    return '0.00';
  }
  return Number(value).toFixed(2);
}

// Store expenses in-memory storage (will reset on serverless function restarts)
let storeExpenses = [];

// Background sync function
async function syncPendingTransactions() {
if (!db || process.env.VERCEL) {
    console.log('Skipping sync in serverless environment');
    return;
  }
  
  
  try {
    // Get pending transactions
    const pendingTransactions = await db.all(`
      SELECT transactionid, receiptid, store FROM rbotransactiontables 
      WHERE synced = 0 
      ORDER BY created_at ASC
      LIMIT 10
    `);
    
    console.log(`Found ${pendingTransactions.length} pending transactions to sync`);
    
    for (const transaction of pendingTransactions) {
      try {
        // Check if transaction exists on the server first
        try {
          const checkResponse = await axios.get(
            `${API_BASE_URL}/rbotransactiontables/${transaction.transactionid}`
          );
          
          if (checkResponse.data && checkResponse.data.success) {
            // Transaction already exists on server, mark as synced
            await db.run(
              `UPDATE rbotransactiontables SET synced = 1, updated_at = CURRENT_TIMESTAMP WHERE transactionid = ?`,
              transaction.transactionid
            );
            console.log(`Transaction ${transaction.transactionid} already exists on server, marked as synced`);
            continue;
          }
        } catch (checkError) {
          // 404 means not found, which is expected
          if (checkError.response && checkError.response.status !== 404) {
            console.error(`Error checking transaction ${transaction.transactionid}:`, checkError.message);
            continue;
          }
        }
        
        // Get transaction data from SQLite
        const transactionData = await db.get(
          `SELECT * FROM rbotransactiontables WHERE transactionid = ?`,
          transaction.transactionid
        );
        
        // Get transaction line items from SQLite
        const transactionLines = await db.all(
          `SELECT * FROM rbotransactionsalestrans WHERE transactionid = ?`,
          transaction.transactionid
        );
        
        if (!transactionData || !transactionLines || transactionLines.length === 0) {
          console.error(`Incomplete data for transaction ${transaction.transactionid}`);
          continue;
        }
        
        // Send to server
        const summaryResponse = await axios.post(
          `${API_BASE_URL}/rbotransactiontables`,
          transactionData,
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
        
        // Mark transaction as synced
        await db.run(
          `UPDATE rbotransactiontables SET synced = 1, updated_at = CURRENT_TIMESTAMP WHERE transactionid = ?`,
          transaction.transactionid
        );
        
        // Send each line item
        for (const line of transactionLines) {
          await axios.post(
            `${API_BASE_URL}/rbotransactionsalestrans`,
            line,
            {
              headers: {
                'Content-Type': 'application/json'
              }
            }
          );
          
          // Mark line as synced
          await db.run(
            `UPDATE rbotransactionsalestrans SET synced = 1, updated_at = CURRENT_TIMESTAMP 
             WHERE transactionid = ? AND linenum = ?`,
            [line.transactionid, line.linenum]
          );
        }
        
        console.log(`Successfully synced transaction ${transaction.transactionid} with ${transactionLines.length} lines`);
      } catch (error) {
        console.error(`Error syncing transaction ${transaction.transactionid}:`, error.message);
        
        // Update last sync attempt
        await db.run(
          `UPDATE rbotransactiontables SET last_sync_attempt = CURRENT_TIMESTAMP WHERE transactionid = ?`,
          transaction.transactionid
        );
      }
    }
  } catch (error) {
    console.error('Error in background sync process:', error);
  }
}

// Run the sync process every 5 minutes
if (!process.env.VERCEL) {
  setInterval(syncPendingTransactions, 5 * 60 * 1000);
}
// Root route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the ECPOS backend server with SQLite persistence!' });
});


 app.get('/api/users', async (req, res) => {
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/getallusers`, { timeout: 30000 });
            // const apiResponse = await axios.get(`http://10.151.5.239:8000/api/getallusers`, { timeout: 90000 });

      const users = apiResponse.data;
  
      if (!users || users.length === 0) {
        return res.status(404).json({ error: 'No users found' });
      }
  
      const transformedUsers = users.map(user => ({
        id: user.id || 'Unknown',
        name: user.name || 'Unknown User',
        email: user.email || '',
        storeid: user.storeid || '',
        password: user.password || '',
        two_factor_secret: user.two_factor_secret || null,
        two_factor_recovery_codes: user.two_factor_recovery_codes || null,
        remember_token: user.remember_token || null,
        current_team_id: user.current_team_id || null,
        profile_photo_path: user.profile_photo_path || null,
        role: user.role || 'user'
      }));
  
      res.status(200).json(transformedUsers);
    } catch (error) {
      console.error('Error fetching users:', error.message);
      if (error.response) {
        res.status(error.response.status).json({ error: 'Error from external API', details: error.response.data });
      } else if (error.request) {
        res.status(503).json({ error: 'External API is unavailable' });
      } else {
        res.status(500).json({ error: 'Internal server error', details: error.message });
      }
    }
  });
  // GET API endpoint to retrieve attendance records for a store
app.get('/api/api-attendance/store/:storeId', async (req, res) => {
  try {
    console.log('Received attendance GET request for store:', req.params.storeId);
    
    const { storeId } = req.params;

    // Validate storeId
    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: 'Store ID is required',
        data: [],
        count: 0,
        store_id: null
      });
    }

    console.log('Forwarding to Laravel...');

    // Forward request to Laravel
    const response = await axios({
      method: 'get',
      url: `${API_BASE_URL}/api-attendance/store/${storeId}`,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    console.log('Laravel response received:', {
      status: response.status,
      dataLength: response.data?.data?.length || 0
    });

    // Send back the response in the expected format
    res.status(200).json({
      success: true,
      message: response.data.message || 'Store attendance records retrieved successfully.',
      data: response.data.data || [],
      count: response.data.count || response.data.data?.length || 0,
      store_id: storeId.toLowerCase()
    });
    
  } catch (error) {
    console.error('Error in attendance GET endpoint:', error);

    // Handle axios errors specifically
    if (error.response) {
      console.error('Laravel error response:', {
        status: error.response.status,
        data: error.response.data
      });
      
      res.status(error.response.status || 500).json({
        success: false,
        message: error.response.data?.message || 'Failed to retrieve attendance records',
        data: [],
        count: 0,
        store_id: storeId?.toLowerCase() || null
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve attendance records',
        error: error.message,
        data: [],
        count: 0,
        store_id: storeId?.toLowerCase() || null
      });
    }
  }
});
// Z-Report endpoint
app.post('/api/rbotransactiontables/:storeId/:zReportId', async (req, res) => {
    const { storeId, zReportId } = req.params;
    console.log(`Updating transactions for store ${storeId} with Z-Report ID: ${zReportId}`);
  
    try {
      // First update locally
      if (db) {
        await db.run(
          `UPDATE rbotransactiontables SET zReportid = ?, updated_at = CURRENT_TIMESTAMP 
           WHERE store = ? AND (zReportid IS NULL OR zReportid = '')`,
          [zReportId, storeId]
        );
      }
      
      // Then try to update on the server
      try {
        const apiResponse = await axios.post(
          `${API_BASE_URL}/rbotransactiontables/${storeId}/${zReportId}`,
          {}, 
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
  
        if (apiResponse.data.success) {
          res.status(200).json({
            success: true,
            message: 'Transactions updated with Z-Report ID successfully',
            data: {
              storeId: storeId,
              zReportId: zReportId,
              updatedTransactions: apiResponse.data.updatedCount || 0,
              timestamp: new Date().toISOString()
            }
          });
        } else {
          throw new Error('Failed to update transactions with Z-Report ID');
        }
      } catch (error) {
        console.error('Error updating transactions with Z-Report ID on server:', error.message);
        
        // Return success for the local update
        res.status(200).json({
          success: true,
          message: 'Transactions updated locally with Z-Report ID, will sync to server later',
          data: {
            storeId: storeId,
            zReportId: zReportId,
            localOnly: true,
            timestamp: new Date().toISOString()
          }
        });
      }
    } catch (error) {
      console.error('Error updating transactions with Z-Report ID:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to update transactions with Z-Report ID',
        details: error.message
      });
    }
  });
  
  // Stock counting endpoint
  app.post('/api/stock-counting/:storeId/:posted/:journalId', async (req, res) => {
    const { storeId, posted, journalId } = req.params;

    try {
      const apiResponse = await axios.post(
        `${API_BASE_URL}/stock-counting/${storeId}/${posted}/${journalId}`,
        {},
        {
          headers: {
            'Content-Type': 'application/json'
          },
          httpsAgent: httpsAgent
        }
      );
  
      if (apiResponse.data.success) {
        res.status(200).json({
          success: true,
          message: 'Stock counting updated successfully',
          data: {
            storeId,
            journalId,
            posted,
            timestamp: new Date().toISOString()
          }
        });
      } else {
        throw new Error('Failed to update stock counting');
      }
    } catch (error) {
      console.error('Error updating stock counting:', error.message);
      const statusCode = error.response ? error.response.status : 500;
      res.status(statusCode).json({
        success: false,
        error: 'Failed to update stock counting',
        details: error.message
      });
    }
  });

  // Batch count POST endpoint - receives complete batch from app and posts to master site
  app.post('/api/stock-counting/batch/post', async (req, res) => {
    try {
      const { storeid, localjournalid, description, items } = req.body;

      console.log('Middleware: Receiving batch post request', {
        storeid: storeid,
        localjournalid: localjournalid,
        itemCount: items ? items.length : 0,
        fullBody: req.body
      });

      // Validate required fields
      if (!storeid) {
        return res.status(400).json({
          success: false,
          message: 'Store ID is required',
          error: 'storeid field is missing from request'
        });
      }

      // Forward request to master site (keep lowercase keys)
      const apiResponse = await axios.post(
        `${API_BASE_URL}/stock-counting/batch/post`,
        {
          storeid: storeid,
          localjournalid: localjournalid,
          description: description,
          items: items
        },
        {
          headers: {
            'Content-Type': 'application/json'
          },
          httpsAgent: httpsAgent,
          timeout: 60000 // 60 second timeout for large batches
        }
      );

      console.log('Middleware: Batch posted successfully to master site', {
        success: apiResponse.data.success,
        journalId: apiResponse.data.journalId
      });

      res.status(200).json(apiResponse.data);
    } catch (error) {
      console.error('Middleware: Error posting batch to master site:', {
        error: error.message,
        response: error.response?.data
      });

      const statusCode = error.response ? error.response.status : 500;
      res.status(statusCode).json({
        success: false,
        message: error.response?.data?.message || 'Failed to post batch to master site',
        error: error.message
      });
    }
  });

  // Get posted batches for a store (debugging/monitoring)
  app.get('/api/stock-counting/posted-batches/:storeId', async (req, res) => {
    try {
      const { storeId } = req.params;
      const limit = req.query.limit || 50;
      const offset = req.query.offset || 0;

      console.log('Middleware: Fetching posted batches', { storeId, limit, offset });

      const apiResponse = await axios.get(
        `${API_BASE_URL}/stock-counting/posted-batches/${storeId}`,
        {
          params: { limit, offset },
          httpsAgent: httpsAgent
        }
      );

      res.status(200).json(apiResponse.data);
    } catch (error) {
      console.error('Middleware: Error fetching posted batches:', error.message);
      const statusCode = error.response ? error.response.status : 500;
      res.status(statusCode).json({
        success: false,
        message: error.response?.data?.message || 'Failed to fetch posted batches',
        error: error.message
      });
    }
  });

  // Get batch items for a specific journal (debugging/monitoring)
  app.get('/api/stock-counting/batch-items/:journalId', async (req, res) => {
    try {
      const { journalId } = req.params;
      const limit = req.query.limit || 100;
      const offset = req.query.offset || 0;

      console.log('Middleware: Fetching batch items', { journalId, limit, offset });

      const apiResponse = await axios.get(
        `${API_BASE_URL}/stock-counting/batch-items/${journalId}`,
        {
          params: { limit, offset },
          httpsAgent: httpsAgent
        }
      );

      res.status(200).json(apiResponse.data);
    } catch (error) {
      console.error('Middleware: Error fetching batch items:', error.message);
      const statusCode = error.response ? error.response.status : 500;
      res.status(statusCode).json({
        success: false,
        message: error.response?.data?.message || 'Failed to fetch batch items',
        error: error.message
      });
    }
  });

  // Get batch statistics for a store (debugging/monitoring)
  app.get('/api/stock-counting/batch-stats/:storeId', async (req, res) => {
    try {
      const { storeId } = req.params;
      const dateFrom = req.query.date_from;
      const dateTo = req.query.date_to;

      console.log('Middleware: Fetching batch stats', { storeId, dateFrom, dateTo });

      const apiResponse = await axios.get(
        `${API_BASE_URL}/stock-counting/batch-stats/${storeId}`,
        {
          params: { date_from: dateFrom, date_to: dateTo },
          httpsAgent: httpsAgent
        }
      );

      res.status(200).json(apiResponse.data);
    } catch (error) {
      console.error('Middleware: Error fetching batch stats:', error.message);
      const statusCode = error.response ? error.response.status : 500;
      res.status(statusCode).json({
        success: false,
        message: error.response?.data?.message || 'Failed to fetch batch stats',
        error: error.message
      });
    }
  });

  // Line details API endpoint
  app.post('/api/line/:itemId/:storeId/:journalId/:adjustment/:receivedCount/:transferCount/:wasteCount/:wasteType/:counted', async (req, res) => {
    const {
      itemId,
      storeId,
      journalId,
      adjustment,
      receivedCount,
      transferCount,
      wasteCount,
      wasteType,
      counted
    } = req.params;

    try {
      const apiResponse = await axios.post(
        `${API_BASE_URL}/line/${itemId}/${storeId}/${journalId}/${adjustment}/${receivedCount}/${transferCount}/${wasteCount}/${wasteType}/${counted}`,
        {},
        {
          headers: {
            'Content-Type': 'application/json'
          },
          httpsAgent: httpsAgent
        }
      );
  
      if (apiResponse.data.success) {
        res.status(200).json({
          success: true,
          message: 'Line details updated successfully',
          data: {
            itemId,
            storeId,
            journalId,
            adjustment,
            receivedCount,
            transferCount,
            wasteCount,
            wasteType,
            counted,
            timestamp: new Date().toISOString()
          }
        });
      } else {
        throw new Error('Failed to update line details');
      }
    } catch (error) {
      console.error('Error updating line details:', error.message);
      const statusCode = error.response ? error.response.status : 500;
      res.status(statusCode).json({
        success: false,
        error: 'Failed to update line details',
        details: error.message
      });
    }
  });
  
  // Get Sequence endpoint
  app.get('/api/getsequence/:storeId', async (req, res) => {
    const { storeId } = req.params;
    console.log(`Received request for number sequence for store: ${storeId}`);
  
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/getsequence/${storeId}`);
      const numberSequenceValues = apiResponse.data.nubersequencevalues;
  
      if (!numberSequenceValues || !Array.isArray(numberSequenceValues) || numberSequenceValues.length === 0) {
        console.error('Invalid or empty number sequence received:', numberSequenceValues);
        return res.status(500).json({ error: 'Invalid number sequence data received from API' });
      }
  
      const transformedSequence = numberSequenceValues.map(sequence => ({
        numberSequence: sequence.NUMBERSEQUENCE,
        nextRec: sequence.CARTNEXTREC,
        NEXTREC: sequence.CARTNEXTREC,
        cartNextRec: sequence.CARTNEXTREC,
        bundleNextRec: sequence.BUNDLENEXTREC,
        discountNextRec: sequence.DISCOUNTNEXTREC,
        storeId: sequence.STOREID,
        createdAt: sequence.created_at,
        updatedAt: sequence.updated_at,
        wasteRec: sequence.wasterec,
        toNextRec: sequence.TONEXTREC,
        stockNextRec: sequence.STOCKNEXTREC
      }));
  
      console.log(`Fetched number sequence for store ${storeId}:`, transformedSequence);
      res.status(200).json(apiResponse.data);
    } catch (error) {
      console.error('Error fetching number sequence:', error.message);
      res.status(error.response ? error.response.status : 500)
        .json({ error: 'Failed to fetch number sequence', details: error.message });
    }
  });
  
  // Update number sequence endpoint
  app.post('/api/getsequence/:storeId/:nextRec', async (req, res) => {
    const { storeId, nextRec } = req.params;
    console.log(`Updating number sequence for store ${storeId} with NEXTREC: ${nextRec}`);
  
    try {
      const apiResponse = await axios.post(
        `${API_BASE_URL}/getsequence/${storeId}/${nextRec}`,
        {} 
      );
  
      if (apiResponse.data.message === "Record updated successfully") {
        res.status(200).json({
          success: true,
          message: 'Number sequence updated successfully',
          data: apiResponse.data.data
        });
      } else {
        throw new Error('Failed to update number sequence');
      }
    } catch (error) {
      console.error('Error updating number sequence:', error.message);
      const statusCode = error.response ? error.response.status : 500;
      res.status(statusCode).json({
        success: false,
        error: 'Failed to update number sequence',
        details: error.message
      });
    }
  });
  
  // Get stock counting
  app.get('/api/stock-counting/:storeId', async (req, res) => {
    const { storeId } = req.params;

    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/stock-counting/${storeId}`, {
        httpsAgent: httpsAgent
      });
      const stockCountingData = apiResponse.data.data;
      
      if (!stockCountingData || !Array.isArray(stockCountingData)) {
        return res.status(500).json({ 
          success: false, 
          error: 'Invalid data received' 
        });
      }
  
      const transformedData = stockCountingData.map(item => ({
        journalId: item.journalid,
        storeId: item.storeid,
        description: item.description,
        quantity: item.qty,
        amount: item.amount,
        posted: item.posted,
        updatedAt: item.updated_at,
        journalType: item.journaltype,
        createdDateTime: item.createddatetime
      }));
  
      res.json({
        success: true,
        data: transformedData
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch stock counting',
        details: error.message
      });
    }
  });  

// Get line details
app.get('/api/line/:storeId/:journalId', async (req, res) => {
    const { storeId, journalId } = req.params;

    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/line/${storeId}/${journalId}`, {
        httpsAgent: httpsAgent
      });
      const lineData = apiResponse.data;
      
      if (!lineData.success || !lineData.data || !lineData.data.transactions) {
        return res.status(500).json({ 
          success: false, 
          error: 'Invalid data received' 
        });
      }
  
      const transformedTransactions = lineData.data.transactions.map(item => ({
        journalId: item.JOURNALID || '',
        lineNum: item.LINENUM,
        transDate: item.TRANSDATE || '',
        itemId: item.ITEMID || '',
        itemDepartment: item.ITEMDEPARTMENT || '',
        storeName: item.STORENAME || '',
        adjustment: item.ADJUSTMENT || '',
        costPrice: item.COSTPRICE,
        priceUnit: item.PRICEUNIT,
        salesAmount: item.SALESAMOUNT,
        inventOnHand: item.INVENTONHAND,
        counted: item.COUNTED || '0',
        reasonRefRecId: item.REASONREFRECID,
        variantId: item.VARIANTID,
        posted: item.POSTED || 0,
        postedDateTime: item.POSTEDDATETIME,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        wasteCount: item.WASTECOUNT || '0',
        receivedCount: item.RECEIVEDCOUNT || '0',
        wasteType: item.WASTETYPE,
        transferCount: item.TRANSFERCOUNT,
        wasteDate:  item.TRANSDATE || '',
        itemGroupId: item.itemgroupid || '',
        itemName: item.itemname || '',
        itemType: item.itemtype || 0,
        nameAlias: item.namealias || '',
        notes: item.notes || '',
        itemGroup: item.itemgroup || '',
        itemDepartmentLower: item.itemdepartment || '',
        zeroPriceValid: item.zeropricevalid || 0,
        dateBlocked: item.dateblocked || '',
        dateToBeBlocked: item.datetobeblocked || '',
        blockedOnPos: item.blockedonpos || 0,
        activeOnDelivery: item.Activeondelivery || 0,
        barcode: item.barcode || '',
        dateToActivateItem: item.datetoactivateitem,
        mustSelectUom: item.mustselectuom || 0,
        production: item.PRODUCTION,
        moq: item.moq || 0,
        fgCount: item.fgcount,
        transparentStocks: item.TRANSPARENTSTOCKS,
        stocks: item.stocks,
        postedLower: item.posted || 0
      }));
  
      res.json({
        success: true,
        data: {
          transactions: transformedTransactions
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch line details',
        details: error.message
      });
    }
  });

// Transaction checking endpoint
app.post('/api/getdata/:storeId/:getsummary/:getdetails', async (req, res) => {
    const { storeId, getsummary, getdetails } = req.params;
    
    try {
      const apiResponse = await axios.post(
        `${API_BASE_URL}/getdata/${storeId}/${getsummary}/${getdetails}`
      );
  
      res.status(200).json(apiResponse.data);
    } catch (error) {
      console.error('Error checking transaction match:', error.message);
      res.status(500).json({
        error: 'Failed to check transaction match',
        details: error.message
      });
    }
  });
  
  // Loyalty cards endpoint
  app.get('/api/loyalty-cards', async (req, res) => {
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/loyalty-cards`);
      
      const loyaltyCards = apiResponse.data.data.loyalty_cards;
      if (!loyaltyCards || !Array.isArray(loyaltyCards)) {
        return res.status(500).json({
          error: 'Invalid data format from upstream API',
          details: 'Expected loyalty_cards array'
        });
      }
  
      const transformedCards = loyaltyCards.map(card => ({
        id: card.id || 0,
        cardNumber: card.card_number || "",
        customerId: card.customer_id || 0,
        customerName: card.customer_name || null,
        points: card.points || 0,
        pointsFormatted: card.points_formatted || "0",
        tier: card.tier || "bronze",
        status: card.status || "inactive",
        expiryDate: card.expiry_date || null,
        createdAt: card.created_at || null,
        isActive: card.is_active || false
      }));
  
      res.status(200).json({
        data: {
          loyalty_cards: transformedCards
        }
      });
    } catch (error) {
      console.error('Error fetching loyalty cards:', error.message);
      res.status(500).json({
        error: 'Failed to fetch loyalty cards',
        details: error.message
      });
    }
  });
  
  // Update loyalty points
  app.post('/api/updatepoints/updatepoints/:cardNumber/:points', async (req, res) => {
    const { cardNumber, points } = req.params;
    
    try {
      const apiResponse = await axios.post(
        `${API_BASE_URL}/updatepoints/updatepoints/${cardNumber}/${points}`
      );
      
      res.status(200).json({
        message: "Points updated successfully",
        data: {
          card_number: cardNumber,
          old_points: apiResponse.data.data.old_points || 0,
          new_points: points,
          updated_at: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Error updating loyalty points:', error.message);
      res.status(500).json({
        error: 'Failed to update loyalty points',
        details: error.message
      });
    }
  });

app.get('/api/store-expenses', async (req, res) => {
    try {
      const { store_id } = req.query;
      
      const filteredExpenses = store_id 
        ? storeExpenses.filter(expense => expense.store_id === store_id)
        : storeExpenses;
  
      const transformedExpenses = filteredExpenses.map(expense => ({
        id: expense.id || 0,
        name: expense.name || "",
        expenseType: expense.expense_type || "",
        amount: parseFloat(expense.amount) || 0.0,
        amountFormatted: expense.amount_formatted || expense.amount || "0.00",
        receivedBy: expense.received_by || expense.receivedBy || "",
        approvedBy: expense.approved_by || expense.approvedBy || "",
        effectDate: expense.effect_date || expense.effectDate || null,
        storeId: expense.store_id || expense.storeId || "",
        syncStatus: expense.sync_status || 0,
        timestamp: expense.timestamp || Date.now(),
        createdAt: expense.created_at || null,
        updatedAt: expense.updated_at || null
      }));
      
      res.status(200).json({
        storeExpense: transformedExpenses
      });
    } catch (error) {
      console.error('Error fetching store expenses:', error.message);
      res.status(500).json({
        error: 'Failed to fetch store expenses',
        details: error.message
      });
    }
  });

app.post('/api/store-expenses', async (req, res) => {
    try {
      const { 
        id, 
        name, 
        expense_type, 
        amount, 
        received_by, 
        approved_by, 
        effect_date, 
        store_id 
      } = req.body;
  
      const newExpense = {
        id: id || (storeExpenses.length + 1),
        name,
        expense_type,
        amount: String(amount),
        received_by: received_by || '',
        approved_by: approved_by || '',
        effect_date: effect_date || new Date().toISOString(),
        store_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
  
      const existingIndex = storeExpenses.findIndex(e => e.id === newExpense.id);
      if (existingIndex !== -1) {
        storeExpenses[existingIndex] = newExpense;
      } else {
        storeExpenses.push(newExpense);
      }
  
      res.status(201).json({
        storeExpense: [newExpense]
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to process store expense', 
        details: error.message 
      });
    }
  });

app.get('/api/getsummary/:storeId', async (req, res) => {
    const { storeId } = req.params;
    
    try {
      // First check if we have any local unsynced data
      let localTransactions = [];
      
      if (db) {
        localTransactions = await db.all(
          `SELECT * FROM rbotransactiontables WHERE store = ? AND synced = 0`,
          storeId
        );
      }
      
      // Then get data from the server
      const apiResponse = await axios.get(`${API_BASE_URL}/getsummary/${storeId}`);
      const data = apiResponse.data;
      
      if (!data.rbotransactiontables) {
        return res.status(500).json({
          error: 'Missing rbotransactiontables in response',
          details: 'Expected rbotransactiontables array'
        });
      }
  
      // Transform server data
      const transformedSummaries = data.rbotransactiontables.map(summary => ({
        transactionId: summary.transactionid,
        type: Number(summary.type) || 0,
        receiptId: summary.receiptid || "",
        store: summary.store || "",
        staff: summary.staff || "",
        customerAccount: summary.custaccount || "",
        netAmount: parseFloat(summary.netamount) || 0.0,
        costAmount: parseFloat(summary.costamount) || 0.0,
        grossAmount: parseFloat(summary.grossamount) || 0.0,
        partialPayment: parseFloat(summary.partialpayment) || 0.0,
        transactionStatus: Number(summary.transactionstatus) || 0,
        discountAmount: parseFloat(summary.discamount) || 0.0,
        customerDiscountAmount: parseFloat(summary.custdiscamount) || 0.0,
        totalDiscountAmount: parseFloat(summary.totaldiscamount) || 0.0,
        numberOfItems: parseFloat(summary.numberofitems) || 0.0,
        refundReceiptId: summary.refundreceiptid,
        currency: summary.currency || "PHP",
        Zreportid: summary.Zreportid,
        zReportid: summary.zReportid,
        ZReportid: summary.ZReportid,
        zreportid: summary.zreportid,
        zReportId: summary.zreportid,
        vatamount: parseFloat(summary.taxinclinprice) || 0.0,
        vatAmount: parseFloat(summary.taxinclinprice) || 0.0,
        vatableSales: parseFloat(summary.vatableSales) || 0.0,
        vatablesales: parseFloat(summary.vatableSales) || 0.0,
        vatablSales: parseFloat(summary.netamountnotincltax) || 0.0,
        createdDate: summary.createddate,
        priceOverride: parseFloat(summary.priceoverride) || 0.0,
        comment: summary.comment || "",
        receiptEmail: summary.receiptemail,
        markupAmount: parseFloat(summary.markupamount) || 0.0,
        markupDescription: summary.markupdescription,
        taxIncludedInPrice: parseFloat(summary.taxinclinprice) || 0.0,
        windowNumber: Number(summary.window_number) || 1,
        gCash: parseFloat(summary.gcash) || 0.0,
        payMaya: parseFloat(summary.paymaya) || 0.0,
        cash: parseFloat(summary.cash) || 0.0,
        card: parseFloat(summary.card) || 0.0,
        loyaltyCard: parseFloat(summary.loyaltycard) || 0.0,
        charge: parseFloat(summary.charge) || 0.0,
        foodpanda: parseFloat(summary.foodpanda) || 0.0,
        grabfood: parseFloat(summary.grabfood) || 0.0,
        representation: parseFloat(summary.representation) || 0.0,
        storeKey: summary.store_key || "",
        storeSequence: summary.store_sequence || "",
        discountType: summary.discofferid || "",
        syncStatus: true,
        syncstatus: true
      }));
      
      // Add local unsynced transactions
      const localTransformedSummaries = localTransactions.map(summary => ({
        transactionId: summary.transactionid,
        type: Number(summary.type) || 0,
        receiptId: summary.receiptid || "",
        store: summary.store || "",
        staff: summary.staff || "",
        customerAccount: summary.custaccount || "",
        netAmount: parseFloat(summary.netamount) || 0.0,
        costAmount: parseFloat(summary.costamount) || 0.0,
        grossAmount: parseFloat(summary.grossamount) || 0.0,
        partialPayment: parseFloat(summary.partialpayment) || 0.0,
        transactionStatus: Number(summary.transactionstatus) || 0,
        discountAmount: parseFloat(summary.discamount) || 0.0,
        customerDiscountAmount: parseFloat(summary.custdiscamount) || 0.0,
        totalDiscountAmount: parseFloat(summary.totaldiscamount) || 0.0,
        numberOfItems: parseFloat(summary.numberofitems) || 0.0,
        refundReceiptId: summary.refundreceiptid,
        currency: summary.currency || "PHP",
        zReportid: summary.zReportid,
        vatamount: parseFloat(summary.taxinclinprice) || 0.0,
        vatAmount: parseFloat(summary.taxinclinprice) || 0.0,
        createdDate: summary.createddate,
        comment: summary.comment || "",
        taxIncludedInPrice: parseFloat(summary.taxinclinprice) || 0.0,
        windowNumber: Number(summary.window_number) || 1,
        gCash: parseFloat(summary.gcash) || 0.0,
        payMaya: parseFloat(summary.paymaya) || 0.0,
        cash: parseFloat(summary.cash) || 0.0,
        card: parseFloat(summary.card) || 0.0,
        loyaltyCard: parseFloat(summary.loyaltycard) || 0.0,
        charge: parseFloat(summary.charge) || 0.0,
        foodpanda: parseFloat(summary.foodpanda) || 0.0,
        grabfood: parseFloat(summary.grabfood) || 0.0,
        representation: parseFloat(summary.representation) || 0.0,
        syncStatus: false,
        syncstatus: false,
        localOnly: true
      }));
      
      // Combine server and local data
      const combinedSummaries = [...transformedSummaries, ...localTransformedSummaries];
      
      res.status(200).json(combinedSummaries);
    } catch (error) {
      console.error('Error details:', error);
      res.status(500).json({
        error: 'Failed to fetch transaction summaries',
        details: error.message
      });
    }
  });

// Get transaction details
app.get('/api/getdetails/:storeId', async (req, res) => {
    const { storeId } = req.params;
    
    try {
      // First check if we have any local unsynced data
      let localDetails = [];
      
      if (db) {
        // Get transaction IDs for the store
        const localTransactions = await db.all(
          `SELECT transactionid FROM rbotransactiontables WHERE store = ? AND synced = 0`,
          storeId
        );
        
        // Get details for those transactions
        if (localTransactions.length > 0) {
          const transactionIds = localTransactions.map(t => t.transactionid);
          const placeholders = transactionIds.map(() => '?').join(',');
          
          localDetails = await db.all(
            `SELECT * FROM rbotransactionsalestrans WHERE transactionid IN (${placeholders})`,
            transactionIds
          );
        }
      }
      
      // Then get data from the server
      const apiResponse = await axios.get(`${API_BASE_URL}/getdetails/${storeId}`);
  
      if (!apiResponse.data.rbotransactionsalestrans) {
        return res.status(500).json({
          error: 'Invalid data format from upstream API',
          details: 'Expected rbotransactionsalestrans array'
        });
      }
  
      // Transform server data
      const transformedDetails = apiResponse.data.rbotransactionsalestrans.map(detail => ({
        id: detail.id || 0,
        transactionId: detail.transactionid,
        receiptNumber: detail.transactionid,
        name: detail.itemname || "",
        price: parseFloat(detail.price) || 0.0,
        quantity: parseInt(detail.qty) || 0,
        subtotal: parseFloat(detail.netamount) || 0.0,
        vat_rate: 0.0,
        vat_amount: parseFloat(detail.taxamount) || 0.0,
        vatamount: parseFloat(detail.taxamount) || 0.0,
        vatAmount: parseFloat(detail.taxamount) || 0.0,
        discount_rate: parseFloat(detail.linediscpct) || 0.0,
        total: parseFloat(detail.grossamount) || 0.0,
        receipt_number: detail.transactionid || "",
        timestamp: new Date(detail.createddate).getTime(),
        payment_method: detail.paymentMethod || "Cash",
        paymentMethod: detail.paymentMethod || "Cash",
        paymentmethod: detail.paymentMethod || "Cash",
        ar: 0.0,
        window_number: 1,
        partial_payment_amount: 0.0,
        comment: detail.remarks || "",
        linenum: parseInt(detail.linenum) || 0,
        receiptId: detail.transactionid || "",
        itemId: detail.itemid || "",
        itemGroup: detail.itemgroup || "",
        netPrice: parseFloat(detail.netprice) || 0.0,
        costAmount: parseFloat(detail.costamount) || 0.0,
        netAmount: parseFloat(detail.netamount) || 0.0,
        grossAmount: parseFloat(detail.grossamount) || 0.0,
        customerAccount: detail.custaccount || "",
        store: detail.store || "",
        priceOverride: parseFloat(detail.priceoverride) || 0.0,
        staff: detail.staff || "",
        discountOfferId: detail.discofferid,
        discount_amount: parseFloat(detail.discount_amount) || 0.0,
        discountamount: parseFloat(detail.discamount) || 0.0,
        discountAmount: parseFloat(detail.discamount) || 0.0,
        lineDiscountAmount: parseFloat(detail.linedscamount) || 0.0,
        lineDiscountPercentage: parseFloat(detail.linediscpct) || 0.0,
        customerDiscountAmount: parseFloat(detail.custdiscamount) || 0.0,
        unit: detail.unit || "",
        unitQuantity: parseFloat(detail.unitqty) || 0.0,
        unitPrice: parseFloat(detail.unitprice) || 0.0,
        taxAmount: parseFloat(detail.taxamount) || 0.0,
        createdDate: detail.createddate || null,
        remarks: detail.remarks || "",
        inventoryBatchId: detail.inventbatchid,
        inventoryBatchExpiryDate: detail.inventbatchexpdate,
        giftCard: detail.giftcard,
        returnTransactionId: detail.returntransactionid,
        returnQuantity: parseFloat(detail.returnqty) || 0.0,
        creditMemoNumber: detail.creditmemonumber,
        taxIncludedInPrice: parseFloat(detail.taxinclinprice) || 0.0,
        description: detail.description || "",
        returnLineId: parseFloat(detail.returnlineid) || 0.0,
        priceUnit: parseFloat(detail.priceunit) || 0.0,
        netAmountNotIncludingTax: parseFloat(detail.netamountnotincltax) || 0.0,
        storeTaxGroup: detail.storetaxgroup,
        currency: detail.currency || "PHP",
        taxExempt: parseFloat(detail.taxexempt) || 0.0,
        isSelected: false,
        isReturned: false,
        discountType: detail.discofferid || "",
        overriddenPrice: null,
        originalPrice: null,
        store_key: detail.store_key || storeId,
        store_sequence: detail.store_sequence || "0",
        syncstatusrecord: true,
        syncStatusRecord: true
      }));
      
      // Transform local details
      const localTransformedDetails = localDetails.map(detail => ({
        id: 0, // Local record doesn't have an ID yet
        transactionId: detail.transactionid,
        receiptNumber: detail.transactionid,
        name: detail.itemname || "",
        price: parseFloat(detail.price) || 0.0,
        quantity: parseInt(detail.qty) || 0,
        subtotal: parseFloat(detail.netamount) || 0.0,
        vat_rate: 0.0,
        vat_amount: parseFloat(detail.taxamount) || 0.0,
        vatamount: parseFloat(detail.taxamount) || 0.0,
        vatAmount: parseFloat(detail.taxamount) || 0.0,
        discount_rate: parseFloat(detail.linediscpct) || 0.0,
        total: parseFloat(detail.grossamount) || 0.0,
        receipt_number: detail.transactionid || "",
        timestamp: detail.createddate || null,
        payment_method: detail.paymentmethod || "Cash",
        paymentMethod: detail.paymentmethod || "Cash",
        paymentmethod: detail.paymentmethod || "Cash",
        linenum: parseInt(detail.linenum) || 0,
        receiptId: detail.receiptid || "",
        itemId: detail.itemid || "",
        itemGroup: detail.itemgroup || "",
        netPrice: parseFloat(detail.netprice) || 0.0,
        costAmount: parseFloat(detail.costamount) || 0.0,
        netAmount: parseFloat(detail.netamount) || 0.0,
        grossAmount: parseFloat(detail.grossamount) || 0.0,
        customerAccount: detail.custaccount || "",
        store: detail.store || "",
        staff: detail.staff || "",
        discountamount: parseFloat(detail.discamount) || 0.0,
        discountAmount: parseFloat(detail.discamount) || 0.0,
        taxAmount: parseFloat(detail.taxamount) || 0.0,
        createdDate: detail.createddate || null,
        remarks: detail.remarks || "",
        description: detail.description || "",
        currency: detail.currency || "PHP",
        isSelected: false,
        isReturned: false,
        discountType: detail.discofferid || "",
        syncstatusrecord: false,
        syncStatusRecord: false,
        localOnly: true
      }));
      
      // Combine server and local data
      const combinedDetails = [...transformedDetails, ...localTransformedDetails];
  
      res.status(200).json(combinedDetails);
    } catch (error) {
      console.error('Error fetching transaction details:', error.message);
      res.status(500).json({
        error: 'Failed to fetch transaction details',
        details: error.message
      });
    }
  });

// Get staff data
app.get('/api/getStaffData/:storeId', async (req, res) => {
  const { storeId } = req.params;
  
  try {
    const apiResponse = await axios.get(`${API_BASE_URL}/getStaffData/${storeId}`);

    if (!apiResponse.data || !Array.isArray(apiResponse.data)) {
      return res.status(500).json({
        error: 'Invalid data format from upstream API',
        details: 'Expected staff data array'
      });
    }

    const transformedStaff = apiResponse.data.map(staff => ({
      name: staff.name || "",
      passcode: staff.passcode || "",
      image: staff.image || null,
      role: staff.role || "",
      storeid: staff.storeid || storeId
    }));
    
    res.status(200).json(transformedStaff);
  } catch (error) {
    console.error('Error fetching staff data:', error.message);
    res.status(500).json({
        error: 'Failed to fetch staff data',
        details: error.message
      });
    }
  });
  
  app.use('/api/sync-transactions', (req, res, next) => {
    if (!req.body || !req.body.transactionSummary || !req.body.transactionRecords) {
      return next();
    }
    
    try {
      const { transactionSummary } = req.body;
  
      // Normalize data to prevent duplication by standardizing property names
      if (transactionSummary) {
        // Standardize Z-Report ID (pick one format)
        const zReportId = transactionSummary.zReportid || transactionSummary.Zreportid || 
                           transactionSummary.ZReportid || transactionSummary.zreportid;
        
        if (zReportId) {
          transactionSummary.zReportid = zReportId;
          // Remove other variations
          delete transactionSummary.Zreportid;
          delete transactionSummary.ZReportid;
          delete transactionSummary.zreportid;
        }
  
        // Normalize tax data properties
        const taxIncludedInPrice = transactionSummary.taxinclinprice;
        if (taxIncludedInPrice !== undefined) {
          transactionSummary.taxinclinprice = taxIncludedInPrice;
          transactionSummary.vatamount = taxIncludedInPrice;
          transactionSummary.vatAmount = taxIncludedInPrice;
        }
  
        // Normalize vatableSales properties
        const vatableSales = transactionSummary.vatableSales || transactionSummary.vatablesales;
        if (vatableSales !== undefined) {
          transactionSummary.vatableSales = vatableSales;
          delete transactionSummary.vatablesales;
        }
      }
  
      // Deduplicate transaction records by linenum if needed
      if (req.body.transactionRecords && Array.isArray(req.body.transactionRecords)) {
        const uniqueRecords = [];
        const recordsByLineNum = {};
  
        req.body.transactionRecords.forEach(record => {
          // Use linenum as unique identifier
          const key = `${record.linenum}`;
          
          // If the record doesn't exist yet, add it
          if (!recordsByLineNum[key]) {
            // Normalize tax properties
            const taxAmount = record.taxamount;
            if (taxAmount !== undefined) {
              record.taxamount = taxAmount;
              record.vatamount = taxAmount;
              record.vatAmount = taxAmount;
            }
  
            // Standardize payment method
            const paymentMethod = record.paymentMethod || record.paymentmethod;
            if (paymentMethod) {
              record.paymentmethod = paymentMethod;
              delete record.paymentMethod;
            }
  
            recordsByLineNum[key] = record;
            uniqueRecords.push(record);
          }
        });
  
        // Replace original records with deduplicated set
        req.body.transactionRecords = uniqueRecords;
      }
      
      next();
    } catch (error) {
      console.error('Error in transaction deduplication middleware:', error);
      next(); // Continue even if deduplication fails
    }
  });
  
  // Add middleware to deduplicate refund data
  app.use('/api/transaction-refund/:storeid/:count', (req, res, next) => {
    if (!req.body || !req.body.items || !Array.isArray(req.body.items)) {
      return next();
    }
    
    try {
      // Deduplicate refund items
      const uniqueItems = [];
      const itemsByLineNum = {};
      
      req.body.items.forEach(item => {
        const key = `${item.linenum}`;
        
        if (!itemsByLineNum[key]) {
          // Normalize tax fields
          if (item.taxamount !== undefined) {
            item.vatamount = item.taxamount;
            item.vatAmount = item.taxamount;
          }
          
          // Normalize payment method
          if (item.paymentMethod || item.paymentmethod) {
            item.paymentmethod = item.paymentMethod || item.paymentmethod;
            delete item.paymentMethod;
          }
          
          itemsByLineNum[key] = item;
          uniqueItems.push(item);
        }
      });
      
      req.body.items = uniqueItems;
      next();
    } catch (error) {
      console.error('Error in refund deduplication middleware:', error);
      next(); // Continue even if deduplication fails
    }
  });
  
  // Modify the sync-transactions endpoint to check for existing records before sending
  app.post('/api/sync-transactions', async (req, res) => {
    try {
      if (!req.body || !req.body.transactionSummary || !req.body.transactionRecords) {
        return res.status(400).json({
          error: 'Invalid request format',
          details: 'Request must include transactionSummary and transactionRecords'
        });
      }
  
      const { transactionSummary, transactionRecords } = req.body;
  
      if (!transactionSummary.store) {
        return res.status(400).json({
          error: 'Missing store information',
          details: 'Store identifier is required in transactionSummary'
        });
      }
  
      try {
        const storePrefix = transactionSummary.store.toUpperCase();
        // Create store-specific transaction ID
        const uniqueTransactionId = `${storePrefix}${transactionSummary.transactionid}`;
        
        // Create store-specific receipt ID
        const storeReceiptId = `${storePrefix}${transactionSummary.receiptid}`;
  
        // Check if transaction already exists to prevent duplicates
        try {
          const checkResponse = await axios.get(
            `${API_BASE_URL}/rbotransactiontables/${uniqueTransactionId}`
          );
  
          if (checkResponse.data && checkResponse.data.success) {
            // Transaction already exists, return success without resending
            return res.status(200).json({
              message: 'Transaction already synced',
              store: storePrefix,
              transactionId: uniqueTransactionId,
              receiptId: storeReceiptId,
              isExisting: true
            });
          }
        } catch (checkError) {
          // If we get a 404, that means the transaction doesn't exist, which is what we want
          if (checkError.response && checkError.response.status !== 404) {
            console.error('Error checking for existing transaction:', checkError.message);
          }
        }
  
         const truncateText = (text, maxLength = 50) => {
        if (!text) return '';
        return text.length > maxLength ? text.substring(0, maxLength) : text;
      };
        // Format transaction summary data, cleaning up any duplicate fields
        const summaryData = {
          transactionid: uniqueTransactionId,
          store: storePrefix,
          type: String(transactionSummary.type || '0'),
          receiptid: storeReceiptId,
          staff: transactionSummary.staff,
          custaccount: transactionSummary.custaccount || '',
          cashamount: parseFloat(transactionSummary.cashamount || 0).toFixed(2),
          netamount: parseFloat(transactionSummary.netamount).toFixed(2),
          costamount: parseFloat(transactionSummary.costamount).toFixed(2),
          grossamount: parseFloat(transactionSummary.grossamount).toFixed(2),
          partialpayment: parseFloat(transactionSummary.partialpayment || 0).toFixed(2),
          transactionstatus: parseInt(transactionSummary.transactionstatus || 1),
          discamount: parseFloat(transactionSummary.discamount || 0).toFixed(2),
          custdiscamount: parseFloat(transactionSummary.custdiscamount || 0).toFixed(2),
          totaldiscamount: parseFloat(transactionSummary.totaldiscamount || 0).toFixed(2),
          numberofitems: parseInt(transactionSummary.numberofitems),
          currency: transactionSummary.currency || 'PHP',
          createddate: transactionSummary.createddate,
          window_number: parseInt(transactionSummary.window_number || 0),
          taxinclinprice: parseFloat(transactionSummary.taxinclinprice || 0).toFixed(2),
          netamountnotincltax: parseFloat(transactionSummary.netamountnotincltax || 0).toFixed(2),
          priceoverride: parseFloat(transactionSummary.priceoverride || 0).toFixed(2),
          comment: truncateText(transactionSummary.comment || "", 50),

          // Payment methods - standardize to one property per payment type
          charge: String(parseFloat(transactionSummary.charge || '0.00').toFixed(2)),
          gcash: String(parseFloat(transactionSummary.gcash || '0.00').toFixed(2)),
          paymaya: String(parseFloat(transactionSummary.paymaya || '0.00').toFixed(2)),
          cash: String(parseFloat(transactionSummary.cash || '0.00').toFixed(2)),
          card: String(parseFloat(transactionSummary.card || '0.00').toFixed(2)),
          loyaltycard: String(parseFloat(transactionSummary.loyaltycard || '0.00').toFixed(2)),
          foodpanda: String(parseFloat(transactionSummary.foodpanda || '0.00').toFixed(2)),
          grabfood: String(parseFloat(transactionSummary.grabfood || '0.00').toFixed(2)),
          representation: String(parseFloat(transactionSummary.representation || '0.00').toFixed(2)),
          
          // Include Z-report ID with just one standardized field name
          zReportid: transactionSummary.zReportid || transactionSummary.Zreportid || 
                     transactionSummary.ZReportid || transactionSummary.zreportid
        };
  
        // Post transaction summary
        console.log('Posting transaction summary:', JSON.stringify(summaryData, null, 2));
        const summaryResponse = await axios.post(
          `${API_BASE_URL}/rbotransactiontables`,
          summaryData,
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
        console.log('Transaction summary posted successfully');
  
        // Create a set of processed record IDs to avoid duplicates
        const processedLines = new Set();
  
        // Process each transaction record
        const recordPromises = transactionRecords.map(async (record, index) => {
          try {
            // Create unique identifier for this line
            const lineKey = `${uniqueTransactionId}_${record.linenum}`;
            
            // Skip duplicate lines
            if (processedLines.has(lineKey)) {
              return { skipped: true, linenum: record.linenum, reason: 'Duplicate line' };
            }
            
            processedLines.add(lineKey);
            
            // Check if sales transaction line already exists
            try {
              const checkLineResponse = await axios.get(
                `${API_BASE_URL}/rbotransactionsalestrans/${uniqueTransactionId}/${record.linenum}`
              );
              
              if (checkLineResponse.data && checkLineResponse.data.success) {
                return { skipped: true, linenum: record.linenum, reason: 'Line already exists' };
              }
            } catch (checkLineError) {
              // 404 is expected if line doesn't exist
              if (checkLineError.response && checkLineError.response.status !== 404) {
                console.error(`Error checking existing line ${record.linenum}:`, checkLineError.message);
              }
            }
    const truncateText = (text, maxLength = 50) => {
        if (!text) return '';
        return text.length > maxLength ? text.substring(0, maxLength) : text;
      };
            const salesTransData = {
              transactionid: uniqueTransactionId,
              linenum: parseInt(record.linenum),
              receiptid: storeReceiptId,
              
              itemid: String(record.itemid || ''),
              itemname: String(record.itemname || record.description || ''),
              itemgroup: String(record.itemgroup || ''),
              
              price: parseFloat(record.price || 0).toFixed(2),
              netprice: parseFloat(record.netprice || record.price || 0).toFixed(2),
              qty: parseFloat(record.qty || 1).toFixed(2),
              discamount: parseFloat(record.discamount || 0).toFixed(2),
              costamount: parseFloat(record.costamount || 0).toFixed(2),
              netamount: parseFloat(record.netamount || 0).toFixed(2),
              grossamount: parseFloat(record.grossamount || 0).toFixed(2),
              
              custaccount: String(record.custaccount || 'WALK-IN'),
              store: storePrefix,
              priceoverride: parseFloat(record.priceoverride || 0).toFixed(2),
              paymentmethod: String(record.paymentmethod || record.paymentMethod || 'Cash'),
              staff: String(record.staff || 'Unknown'),
              
              linedscamount: parseFloat(record.linedscamount || 0).toFixed(2),
              linediscpct: parseFloat(record.linediscpct || 0).toFixed(2),
              custdiscamount: parseFloat(record.custdiscamount || 0).toFixed(2),
              
              unit: String(record.unit || 'PCS'),
              unitqty: parseFloat(record.unitqty || record.qty || 1).toFixed(2),
              unitprice: parseFloat(record.unitprice || record.price || 0).toFixed(2),
              taxamount: parseFloat(record.taxamount || 0).toFixed(2),
              
              createddate: record.createddate || new Date().toISOString(),
              remarks: truncateText(record.remarks || transactionSummary.comment || transactionSummary.remark || transactionSummary.remarks || '', 50),
              comment: truncateText(record.remarks || transactionSummary.comment || transactionSummary.remark || transactionSummary.remarks || '', 50),


              taxinclinprice: parseFloat(record.taxamount || 0).toFixed(2),
              description: String(record.description || ''),
              
              netamountnotincltax: parseFloat(record.netamountnotincltax || 0).toFixed(2),
              
              // Only include these fields if they have values
              ...(record.inventbatchid ? { inventbatchid: record.inventbatchid } : {}),
              ...(record.inventbatchexpdate ? { inventbatchexpdate: record.inventbatchexpdate } : {}),
              ...(record.giftcard ? { giftcard: record.giftcard } : {}),
              ...(record.returntransactionid ? { returntransactionid: record.returntransactionid } : {}),
              ...(record.returnqty ? { returnqty: parseInt(record.returnqty) } : {}),
              ...(record.creditmemonumber ? { creditmemonumber: record.creditmemonumber } : {}),
              ...(record.returnlineid ? { returnlineid: record.returnlineid } : {}),
              ...(record.priceunit ? { priceunit: record.priceunit } : {}),
              ...(record.storetaxgroup ? { storetaxgroup: record.storetaxgroup } : {}),
              
              currency: record.currency || 'PHP',
              ...(record.taxexempt ? { taxexempt: record.taxexempt } : {}),
              
              // Standardize discount identifier
              discofferid: String(record.discofferid || record.discountOfferId || '')
            };
  
            // Log the data being sent
            console.log(`Sending sales transaction line ${record.linenum}:`, JSON.stringify(salesTransData, null, 2));

            return axios.post(
              `${API_BASE_URL}/rbotransactionsalestrans`,
              salesTransData
            );
          } catch (error) {
            console.error(`Error processing record ${index + 1}:`, {
              error: error.message,
              record: record,
              salesTransData: salesTransData,
              apiResponse: error.response ? error.response.data : null,
              apiStatus: error.response ? error.response.status : null
            });
            throw error;
          }
        });
  
        const recordsResponse = await Promise.all(recordPromises);
  
        return res.status(200).json({
          message: 'Transaction synced successfully',
          store: storePrefix,
          transactionId: uniqueTransactionId,
          receiptId: storeReceiptId,
          summaryResponse: summaryResponse.data,
          recordsResponse: recordsResponse.map(r => r.data || r)
        });
  
      } catch (error) {
        console.error('Error sending to API:', {
          message: error.message,
          response: error.response && error.response.data,
          status: error.response && error.response.status
        });
        
        let errorStatus = 500;
        let errorDetails = error.message;
  
        if (error.response) {
          errorStatus = error.response.status || 500;
          if (error.response.data && error.response.data.message) {
            errorDetails = error.response.data.message;
          }
        }
        
        return res.status(errorStatus).json({
          error: 'Failed to sync with API',
          details: errorDetails,
          status: errorStatus
        });
      }
  
    } catch (error) {
      console.error('Error processing transaction:', error);
      return res.status(500).json({
        error: 'Failed to process transaction',
        details: error.message
      });
    }
  });
  
  // Transaction refund endpoint
  app.post('/api/transaction-refund/:storeid/:count', async (req, res) => {
    try {
      const { storeid, count } = req.params;
      const refundData = req.body;
  
      // Validate request
      if (!refundData || !refundData.transactionid || !refundData.items || !Array.isArray(refundData.items)) {
        return res.status(400).json({
          error: 'Invalid request format',
          details: 'Request must include transactionid and items array'
        });
      }
  
      // Generate refund receipt ID
      const storePrefix = storeid.toUpperCase();
      const refundReceiptId = `RF${count}-${storePrefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  
      // Calculate totals
      let totalRefundAmount = 0;
      let totalRefundCost = 0;
      let totalRefundTax = 0;
      let totalRefundDisc = 0;
  
      refundData.items.forEach(item => {
        totalRefundAmount += parseFloat(item.netamount || 0);
        totalRefundCost += parseFloat(item.costamount || 0);
        totalRefundTax += parseFloat(item.taxamount || 0);
        totalRefundDisc += parseFloat(item.discamount || 0);
      });
  
      // Format transaction table update data
      const transactionUpdate = {
        refundreceiptid: refundReceiptId,
        refunddate: new Date().toISOString(),
        refundby: refundData.refundby,
        netamount: formatDecimal(-totalRefundAmount),
        costamount: formatDecimal(-totalRefundCost),
        grossamount: formatDecimal(-totalRefundAmount),
        discamount: formatDecimal(-totalRefundDisc),
        transactionstatus: refundData.transactionstatus || 2, // Default to refunded status
        type: refundData.type || 'REFUND',
        custaccount: refundData.custaccount,
        cashamount: formatDecimal(refundData.cashamount),
        partialpayment: formatDecimal(refundData.partialpayment),
        custdiscamount: formatDecimal(refundData.custdiscamount),
        totaldiscamount: formatDecimal(refundData.totaldiscamount),
        numberofitems: refundData.numberofitems,
        currency: refundData.currency || 'PHP',
        zreportid: refundData.zreportid,
        comment: refundData.comment,
        receiptemail: refundData.receiptemail,
        markupamount: formatDecimal(refundData.markupamount),
        markupdescription: refundData.markupdescription,
        taxinclinprice: formatDecimal(refundData.taxinclinprice),
        netamountnotincltax: formatDecimal(refundData.netamountnotincltax),
        window_number: refundData.window_number || 0,
        charge: formatDecimal(refundData.charge),
        gcash: formatDecimal(refundData.gcash),
        paymaya: formatDecimal(refundData.paymaya),
        cash: formatDecimal(refundData.cash),
        card: formatDecimal(refundData.card),
        loyaltycard: formatDecimal(refundData.loyaltycard),
        foodpanda: formatDecimal(refundData.foodpanda),
        grabfood: formatDecimal(refundData.grabfood),
        representation: formatDecimal(refundData.representation)
      };
  
      // Update transaction table
      const transactionResponse = await axios.put(
        `${API_BASE_URL}/rbotransactiontables/${refundData.transactionid}`,
        transactionUpdate,
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
  
      // Process each refund item
      const itemPromises = refundData.items.map(async (item) => {
        const salesTransData = {
          transactionid: refundData.transactionid,
          linenum: item.linenum,
          receiptid: refundReceiptId,
          itemid: item.itemid,
          itemname: item.itemname || item.description || '',
          itemgroup: item.itemgroup || '',
          price: formatDecimal(item.price),
          netprice: formatDecimal(item.netprice),
          qty: parseInt(item.qty || 0),
          returnqty: parseInt(item.returnqty || 0),
          discamount: formatDecimal(item.discamount),
          costamount: formatDecimal(item.costamount),
          netamount: formatDecimal(-item.netamount),
          grossamount: formatDecimal(-item.grossamount),
          custaccount: item.custaccount || 'WALK-IN',
          store: storePrefix,
          priceoverride: parseInt(item.priceoverride || 0),
          paymentmethod: item.paymentmethod || 'REFUND',
          staff: refundData.refundby,
          linedscamount: formatDecimal(item.linedscamount),
          linediscpct: formatDecimal(item.linediscpct),
          custdiscamount: formatDecimal(item.custdiscamount),
          unit: item.unit || 'PCS',
          unitqty: formatDecimal(item.unitqty),
          unitprice: formatDecimal(item.unitprice),
          taxamount: formatDecimal(item.taxamount),
          createddate: new Date().toISOString(),
          remarks: item.remarks || 'Refund',
          inventbatchid: item.inventbatchid,
          inventbatchexpdate: item.inventbatchexpdate,
          giftcard: item.giftcard,
          returntransactionid: refundData.transactionid,
          refunddate: new Date().toISOString(),
          refundby: refundData.refundby,
          creditmemonumber: refundReceiptId,
          description: item.description || '',
          returnlineid: item.linenum,
          priceunit: formatDecimal(item.priceunit),
          netamountnotincltax: formatDecimal(item.netamountnotincltax),
          storetaxgroup: item.storetaxgroup,
          currency: item.currency || 'PHP',
          taxexempt: formatDecimal(item.taxexempt),
          wintransid: item.wintransid
        };
  
        return axios.put(
          `${API_BASE_URL}/rbotransactionsalestrans/${refundData.transactionid}/${item.linenum}`,
          salesTransData,
          {
            headers: { 'Content-Type': 'application/json' }
          }
        );
      });
  
      // Wait for all updates to complete
      const itemsResponse = await Promise.all(itemPromises);
  
      return res.status(200).json({
        message: 'Refund processed successfully',
        store: storePrefix,
        refundReceiptId: refundReceiptId,
        transactionId: refundData.transactionid,
        summary: {
          totalRefundAmount: formatDecimal(totalRefundAmount),
          totalRefundCost: formatDecimal(totalRefundCost),
          totalRefundTax: formatDecimal(totalRefundTax),
          totalRefundDisc: formatDecimal(totalRefundDisc)
        },
        transactionResponse: transactionResponse.data,
        itemsResponse: itemsResponse.map(r => r.data)
      });
  
    } catch (error) {
      console.error('Error processing refund:', {
        message: error.message,
        response: error.response && error.response.data,
        status: error.response && error.response.status
      });
  
      let errorStatus = 500;
      let errorMessage = 'Failed to process refund';
      let errorDetails = error.message;
  
      if (error.response) {
        errorStatus = error.response.status || 500;
        if (error.response.data && error.response.data.message) {
          errorDetails = error.response.data.message;
        }
      }
  
      return res.status(errorStatus).json({
        error: errorMessage,
        details: errorDetails,
        status: errorStatus
      });
    }
  });
  
  // Get users
 
  
  // Get products for a store
  app.get('/api/products/get-all-products', async (req, res) => {
    try {
      const storeId = req.query.storeId;
      
      if (!storeId) {
        return res.status(400).json({ error: 'Store ID is required' });
      }
      
      const apiResponse = await axios.get(`${API_BASE_URL}/items/${storeId}`);
      const items = apiResponse.data.items;
      
      if (!items || items.length === 0) {
        throw new Error('No items received from API');
      }
  
      const transformedProducts = items.map(product => ({
        itemid: product.itemid || 'Unknown',
        activeOnDelivery: product.Activeondelivery === 1,
        itemName: product.itemname || 'Unknown Item',
        itemGroup: product.itemgroup || '',
        specialGroup: product.specialgroup || '',
        production: product.production || '',
        moq: product.moq || 0,
        price: product.price || 0,
        cost: product.cost || 0,
        barcode: product.barcode === 'N/A' ? 0 : parseInt(product.barcode, 10) || 0,
        foodpanda: product.foodpanda || 0,
        grabfood: product.grabfood || 0,
        manilaprice: product.manilaprice || 0,
        mallprice: product.mallprice || 0,
        grabfoodmall: product.grabfoodmall || 0,
        foodpandamall: product.foodpandamall || 0
        
        
      
      }));
  
      res.status(200).json(transformedProducts);
    } catch (error) {
      console.error('Error fetching products:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  
  // Get customers
  app.get('/api/customers', async (req, res) => {
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/customers`);
      const customers = apiResponse.data.customers;
  
      if (!customers || !Array.isArray(customers) || customers.length === 0) {
        return res.status(500).json({ error: 'Invalid customer data received from API' });
      }
  
      const transformedCustomers = customers.map(customer => ({
        id: customer.id,
        accountNum: customer.accountnum,
        name: customer.name,
        address: customer.address,
        phone: customer.phone,
        email: customer.email
      }));
  
      res.status(200).json(transformedCustomers);
    } catch (error) {
      console.error('Error fetching customers:', error.message);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  });
  
  // AR Types endpoint
  app.get('/api/ar-types', async (req, res) => {
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/ar`);
      let arTypes = apiResponse.data.arTypes || apiResponse.data.ar || [];
  
      if (!Array.isArray(arTypes)) {
        arTypes = [arTypes];
      }
  
      if (arTypes.length === 0) {
        return res.status(200).json([]);
      }
  
      const transformedARTypes = arTypes.map(arType => ({
        id: arType.id,
        ar: arType.ar
      }));
  
      res.status(200).json(transformedARTypes);
    } catch (error) {
      console.error('Error fetching AR types:', error.message);
      if (error.response && error.response.status === 404) {
        return res.status(200).json([]);
      }
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  });
  
  // Get categories
  app.get('/api/categories/get-all-categories', async (req, res) => {
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/bwcategory`);
      const categories = apiResponse.data.rboinventitemretailgroups;
  
      if (!categories || !Array.isArray(categories) || categories.length === 0) {
        return res.status(500).json({ error: 'Invalid categories data received from API' });
      }
  
      const transformedCategories = categories.map(category => ({
        groupId: parseInt(category.GROUPID, 10),
        name: category.NAME || 'Unknown Category'
      }));
  
      res.status(200).json(transformedCategories);
    } catch (error) {
      console.error('Error fetching categories:', error.message);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  });
  
  // Window tables endpoint
  // Direct windowtable endpoint to match Retrofit path
app.get('/api/windowtable/get-all-tables', async (req, res) => {
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/windowtables`);
      
      // Return the data in the format expected by the client
      res.status(200).json(apiResponse.data);
    } catch (error) {
      console.error('Error fetching window tables:', error.message);
      res.status(500).json({
        error: 'Failed to fetch window tables',
        details: error.message
      });
    }
  });
  
  // Windows endpoint
  app.get('/api/windows/get-all-windows', async (req, res) => {
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/windowtrans`);
      const windows = apiResponse.data.windowtrans;
  
      if (!windows || !Array.isArray(windows) || windows.length === 0) {
        return res.status(500).json({ error: 'Invalid window data received from API' });
      }
  
      const transformedWindows = windows.map(window => ({
        id: parseInt(window.ID, 10),
        description: window.DESCRIPTION || 'Unknown Window',
        windownum: window.WINDOWNUM
      }));
  
      res.status(200).json(transformedWindows);
    } catch (error) {
      console.error('Error fetching windows:', error.message);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  });
  
  // Discounts endpoint
  app.get('/api/discounts/get-all-discounts', async (req, res) => {
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/discounts`);
      let discounts = apiResponse.data.discounts || apiResponse.data;
  
      if (!Array.isArray(discounts) || discounts.length === 0) {
        return res.status(200).json([]);
      }
  
      const transformedDiscounts = discounts.map(discount => ({
        id: parseInt(discount.ID || discount.id, 10) || 0,
        DISCOFFERNAME: (discount.DISCOFFERNAME || discount.discountOfferName || '').trim() || 'Unknown Discount',
        PARAMETER: parseInt(discount.PARAMETER || discount.parameter, 10) || 0,
        DISCOUNTTYPE: ((discount.DISCOUNTTYPE || discount.discountType || '').toLowerCase() || 'unknown').trim(),

        GRABFOOD_PARAMETER: parseInt(discount.GRABFOOD_PARAMETER || discount.GRABFOOD_PARAMETER, 10) || 0,
        FOODPANDA_PARAMETER: parseInt(discount.FOODPANDA_PARAMETER || discount.FOODPANDA_PARAMETER, 10) || 0,
        MANILAPRICE_PARAMETER: parseInt(discount.MANILAPRICE_PARAMETER || discount.MANILAPRICE_PARAMETER, 10) || 0,
        MALLPRICE_PARAMETER: parseInt(discount.MALLPRICE_PARAMETER || discount.MALLPRICE_PARAMETER, 10) || 0,
        GRABFOODMALL_PARAMETER: parseInt(discount.GRABFOODMALL_PARAMETER || discount.GRABFOODMALL_PARAMETER, 10) || 0,
        FOODPANDAMALL_PARAMETER: parseInt(discount.FOODPANDAMALL_PARAMETER || discount.FOODPANDAMALL_PARAMETER, 10) || 0



      }));
  
      res.status(200).json(transformedDiscounts);
    } catch (error) {
      console.error('Error fetching discounts:', error.message);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  });
  
  // Mix Match endpoint
  app.get('/mixmatch', async (req, res) => {
    try {
      const apiResponse = await axios.get(`${API_BASE_URL}/mix-match/discounts`);
      let mixMatches = apiResponse.data.mixMatches || apiResponse.data || [];
  
      if (!Array.isArray(mixMatches)) {
        mixMatches = [mixMatches].filter(Boolean);
      }
  
      const transformedMixMatches = mixMatches.map(mixMatch => {
        const defaultMixMatch = {
          id: '',
          name: 'Unnamed Mix Match',
          description: '',
          discounttype: 0,
          dealpricevalue: 0.0,
          discountpctvalue: 0.0,
          discountamountvalue: 0.0,
          line_groups: []
        };
  
        const data = Object.assign({}, defaultMixMatch, mixMatch);
  
        return {
          id: data.id.toString(),
          name: data.name || `Mix Match ${data.id}`,
          description: data.description || 'No Description',
          discounttype: parseInt(data.discounttype, 10) || 0,
          dealpricevalue: parseFloat(data.dealpricevalue) || 0.0,
          discountpctvalue: parseFloat(data.discountpctvalue) || 0.0,
          discountamountvalue: parseFloat(data.discountamountvalue) || 0.0,
          line_groups: (data.line_groups || []).map(group => {
            const defaultGroup = {
              linegroup: '',
              name: 'Unnamed Group',
              description: '',
              noofitemsneeded: 0,
              discount_lines: []
            };
            const groupData = Object.assign({}, defaultGroup, group);
  
            return {
              linegroup: groupData.linegroup || 'DEFAULT_GROUP',
              name: groupData.name || `Group ${groupData.linegroup}`,
              description: groupData.description || 'No Description',
              noofitemsneeded: parseInt(groupData.noofitemsneeded, 10) || 1,
              discount_lines: (groupData.discount_lines || []).map(line => {
                const defaultLine = {
                  id: 0,
                  itemid: '',
                  name: 'Unnamed Item',
                  disctype: 0,
                  dealpriceordiscpct: 0.0,
                  linegroup: '',
                  qty: 0,
                  itemData: {
                    itemid: '',
                    name: 'Default Item',
                    Activeondelivery: 0,
                    itemname: 'Default Item',
                    itemgroup: 'Default Group',
                    specialgroup: 'Regular',
                    production: 'Default',
                    moq: 1,
                    price: 0.0,
                    cost: 0.0,
                    barcode: 'N/A'
                  }
                };
                const lineData = Object.assign({}, defaultLine, line);
                const itemData = Object.assign({}, defaultLine.itemData, line.itemData || {});
  
                return {
                  id: parseInt(lineData.id, 10) || 0,
                  itemid: lineData.itemid || 'DEFAULT_ITEM',
                  name: lineData.name || `Item ${lineData.itemid}`,
                  disctype: parseInt(lineData.disctype, 10) || 0,
                  dealpriceordiscpct: parseFloat(lineData.dealpriceordiscpct) || 0.0,
                  linegroup: lineData.linegroup || groupData.linegroup,
                  qty: parseInt(lineData.qty, 10) || 1,
                  itemData: {
                    itemid: itemData.itemid || 'DEFAULT_ITEM',
                    name: itemData.name || itemData.itemname || 'Default Item',
                    Activeondelivery: parseInt(itemData.Activeondelivery, 10) || 0,
                    itemname: itemData.itemname || 'Default Item',
                    itemgroup: itemData.itemgroup || 'Default Group',
                    specialgroup: itemData.specialgroup || 'Regular',
                    production: itemData.production || 'Default',
                    moq: parseInt(itemData.moq, 10) || 1,
                    price: parseFloat(itemData.price) || 0.0,
                    cost: parseFloat(itemData.cost) || 0.0,
                    barcode: itemData.barcode || 'N/A'
                  }
                };
              })
            };
          })
        };
      });
  
      res.status(200).json(transformedMixMatches);
    } catch (error) {
      console.error('Error fetching mix matches:', error.message);
      res.status(500).json({ 
        error: 'Internal server error', 
        details: error.message,
        data: [] // Return empty array on error
    });
  }
 });

 // License validation endpoint - proxy to LMS
 app.post('/api/license/validate', async (req, res) => {
  try {
    const { email, license_number, type } = req.body;

    if (!email && !license_number) {
      return res.status(400).json({
        valid: false,
        error: 'Email or license number is required'
      });
    }

    console.log('Validating license:', { email, license_number, type });

    // Call LMS validation endpoint
    const lmsUrl = 'https://lms-one-weld-69.vercel.app/api/licenses/validate';
    const response = await axios.post(lmsUrl, {
      email,
      license_number,
      type: type || 'ECPOS APP'
    });

    console.log('LMS response:', response.data);

    res.status(200).json(response.data);
  } catch (error) {
    console.error('License validation error:', error);

    // If LMS is down or returns error, check the error response
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({
        valid: false,
        error: 'Failed to validate license',
        message: error.message
      });
    }
  }
 });

 // Server time endpoint
 app.get('/api/server-time', (req, res) => {
  try {
    const phTime = moment().tz('Asia/Manila');
    res.status(200).json({
      datetime: phTime.format(),
      timezone: 'Asia/Manila'
    });
  } catch (error) {
    console.error('Error getting server time:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get server time',
      error: error.message
    });
  }
 });
 
 // Attendance endpoint
// Attendance endpoint
app.post('/api/attendance', upload.single('photo'), async (req, res) => {
  try {
    console.log('Received attendance request');
    console.log('Body:', req.body);
    console.log('File info:', req.file ? {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    } : 'No file');

    // Validate required fields
    const { staffId, storeId, date, time, type } = req.body;
    
    if (!staffId || !storeId || !date || !time || !type) {
      return res.status(422).json({
        success: false,
        message: 'Missing required fields',
        errors: {
          staffId: !staffId ? ['Staff ID is required'] : null,
          storeId: !storeId ? ['Store ID is required'] : null,
          date: !date ? ['Date is required'] : null,
          time: !time ? ['Time is required'] : null,
          type: !type ? ['Type is required'] : null
        }
      });
    }

    if (!req.file) {
      return res.status(422).json({
        success: false,
        message: 'Photo is required'
      });
    }

    // Create form data for Laravel
    const formData = new FormData();
    formData.append('staffId', staffId);
    formData.append('storeId', storeId);
    formData.append('date', date);
    formData.append('time', time);
    formData.append('type', type);
    
    // For memory storage, use buffer instead of file stream
    formData.append('photo', req.file.buffer, {
      filename: req.file.originalname || 'photo.jpg',
      contentType: req.file.mimetype || 'image/jpeg'
    });

    console.log('Forwarding to Laravel...');

    // Forward to Laravel
    const response = await axios({
      method: 'post',
      url: `${API_BASE_URL}/attendance`,
      data: formData,
      headers: {
        ...formData.getHeaders(),
        'Accept': 'application/json'
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log('Laravel response:', response.data);

    // Send back the response
    res.status(200).json(response.data);
    
  } catch (error) {
    console.error('Error in attendance endpoint:', error);

    // Handle axios errors specifically
    if (error.response) {
      console.error('Laravel error response:', error.response.data);
      res.status(error.response.status || 500).json(error.response.data);
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to process attendance',
        error: error.message
      });
    }
  }
});

// Make sure uploads directory exists

// ==================== FILE UPLOAD TO VERCEL BLOB ====================

// Upload ECPOS files (BIR, DATABASE_BACKUPS, error_logs) to Vercel Blob
app.post('/api/upload-files', upload.single('archive'), async (req, res) => {
  try {
    console.log('📤 File upload request received');

    const { storeId, storeName } = req.body;

    // Validate required fields
    if (!storeId || !storeName) {
      return res.status(422).json({
        success: false,
        message: 'Missing required fields',
        errors: {
          storeId: !storeId ? ['Store ID is required'] : undefined,
          storeName: !storeName ? ['Store name is required'] : undefined
        }
      });
    }

    // Check if file was uploaded
    if (!req.file) {
      return res.status(422).json({
        success: false,
        message: 'Archive file is required'
      });
    }

    console.log('📦 File received:', {
      filename: req.file.originalname,
      size: `${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
      mimetype: req.file.mimetype,
      storeId,
      storeName
    });

    // Import Vercel Blob SDK (requires @vercel/blob package)
    const { put } = require('@vercel/blob');

    // Generate unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${storeName}_${storeId}_${timestamp}.zip`;

    // Upload to Vercel Blob
    console.log('☁️  Uploading to Vercel Blob...');
    const blob = await put(filename, req.file.buffer, {
      access: 'public',
      addRandomSuffix: false
    });

    console.log('✅ Upload successful:', blob.url);

    // Return success response
    res.status(200).json({
      success: true,
      message: 'Files uploaded successfully to Vercel Blob',
      data: {
        url: blob.url,
        filename: filename,
        size: req.file.size,
        uploadedAt: new Date().toISOString(),
        storeId,
        storeName
      }
    });

  } catch (error) {
    console.error('❌ Error uploading files:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload files',
      error: error.message
    });
  }
});

// Database backup endpoint for version updates
app.post('/api/backup-database', upload.single('database'), async (req, res) => {
  try {
    console.log('💾 Database backup request received');

    const { storeName, storeId, versionFrom, versionTo } = req.body;

    // Validate required fields
    if (!storeName || !storeId) {
      return res.status(422).json({
        success: false,
        message: 'Missing required fields',
        errors: {
          storeName: !storeName ? ['Store name is required'] : undefined,
          storeId: !storeId ? ['Store ID is required'] : undefined
        }
      });
    }

    // Check if file was uploaded
    if (!req.file) {
      return res.status(422).json({
        success: false,
        message: 'Database file is required'
      });
    }

    console.log('💾 Database received:', {
      filename: req.file.originalname,
      size: `${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
      mimetype: req.file.mimetype,
      storeName,
      storeId,
      versionFrom,
      versionTo
    });

    // Import Vercel Blob SDK
    const { put } = require('@vercel/blob');

    // Generate unique filename with version info
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const versionInfo = versionFrom && versionTo ? `_v${versionFrom}-to-v${versionTo}` : '';
    const filename = `backups/${storeName}_${storeId}${versionInfo}_${timestamp}.db`;

    // Upload to Vercel Blob
    console.log('☁️  Uploading database backup to Vercel Blob...');
    const blob = await put(filename, req.file.buffer, {
      access: 'public',
      addRandomSuffix: false
    });

    console.log('✅ Database backup successful:', blob.url);

    // Return success response
    res.status(200).json({
      success: true,
      message: 'Database backup uploaded successfully to Vercel Blob',
      data: {
        url: blob.url,
        filename: filename,
        size: req.file.size,
        uploadedAt: new Date().toISOString(),
        storeName,
        storeId,
        versionFrom,
        versionTo
      }
    });

  } catch (error) {
    console.error('❌ Error backing up database:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to backup database',
      error: error.message
    });
  }
});

// Get list of uploaded files (optional - for viewing history)
app.get('/api/uploaded-files', async (req, res) => {
  try {
    const { list } = require('@vercel/blob');
    const { blobs } = await list();

    res.status(200).json({
      success: true,
      count: blobs.length,
      files: blobs.map(blob => ({
        url: blob.url,
        pathname: blob.pathname,
        size: blob.size,
        uploadedAt: blob.uploadedAt
      }))
    });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list files',
      error: error.message
    });
  }
});

// ==================== END FILE UPLOAD ====================

 const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 API available at: http://localhost:${PORT}`);
    console.log(`🔗 Network access at: http://10.151.5.145:${PORT}`);
    console.log(`🧪 Test endpoint: http://localhost:${PORT}/api/getsummary/lapaz`);
});
//  For Vercel, we need to export the app
 module.exports = app;




