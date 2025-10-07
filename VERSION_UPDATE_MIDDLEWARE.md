# Middleware Version Update Integration

## Overview
This document describes the middleware changes required to support the version update system for the ECPOS application.

## Changes Made

### 1. New Version Check Endpoints

#### A. Get Current Version
```javascript
GET /api/app-version/current
```
- **Purpose**: Retrieves the current active version from the master site
- **Proxy Target**: `${API_BASE_URL}/app-version/current` (https://eljin.org/api/app-version/current)
- **Response**: Current version information from master site

#### B. Check Version Compatibility
```javascript
POST /api/app-version/check
```
- **Purpose**: Checks if the app needs to be updated
- **Proxy Target**: `${API_BASE_URL}/app-version/check` (https://eljin.org/api/app-version/check)
- **Request Body**:
```json
{
  "current_version": "1.0.0"
}
```
- **Response**: Version compatibility information

### 2. Implementation Details

#### Request Flow
```
Android App → Middleware (Vercel) → Master Site (eljin.org) → Response back through chain
```

#### Error Handling
- Network timeouts (30 seconds)
- API response errors from master site
- Detailed error logging for troubleshooting
- Proper HTTP status code forwarding

#### Logging
- Request method and body logging
- Response data logging
- Error details with stack traces
- API response status and data

### 3. Code Implementation

```javascript
// Version Check Endpoints
app.get('/api/app-version/current', async (req, res) => {
  try {
    console.log('Version check: Getting current version from master site');

    const apiResponse = await axios.get(`${API_BASE_URL}/app-version/current`, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    console.log('Version check response:', apiResponse.data);
    res.json(apiResponse.data);

  } catch (error) {
    console.error('Error getting current version:', error.message);

    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve version information from master site',
      error: error.message
    });
  }
});

app.post('/api/app-version/check', async (req, res) => {
  try {
    console.log('Version check: Checking version compatibility');
    console.log('Request body:', req.body);

    const apiResponse = await axios.post(`${API_BASE_URL}/app-version/check`, req.body, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    console.log('Version check response:', apiResponse.data);
    res.json(apiResponse.data);

  } catch (error) {
    console.error('Error checking version:', error.message);

    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    res.status(500).json({
      success: false,
      message: 'Failed to check version from master site',
      error: error.message
    });
  }
});
```

## Configuration

### Environment Variables
The middleware uses the existing `API_BASE_URL` constant:
```javascript
const API_BASE_URL = 'https://eljin.org/api';
```

### Dependencies
No new dependencies required - uses existing:
- `axios` for HTTP requests
- `express` for routing
- Standard error handling middleware

## Testing

### Local Testing
```bash
# Test current version endpoint
curl -X GET http://localhost:3000/api/app-version/current

# Test version check endpoint
curl -X POST http://localhost:3000/api/app-version/check \
  -H "Content-Type: application/json" \
  -d '{"current_version": "1.0.0"}'
```

### Production Testing (Vercel)
```bash
# Test current version endpoint
curl -X GET https://ecpos-middleware.vercel.app/api/app-version/current

# Test version check endpoint
curl -X POST https://ecpos-middleware.vercel.app/api/app-version/check \
  -H "Content-Type: application/json" \
  -d '{"current_version": "1.0.0"}'
```

## Android App Integration

### RetrofitClient Changes
The Android app now routes version requests through the middleware:

```kotlin
private val masterSiteRetrofit = Retrofit.Builder()
    .baseUrl(BASE_URL)  // Uses middleware URL instead of direct master site
    .client(okHttpClient)
    .addConverterFactory(GsonConverterFactory.create(gson))
    .build()
```

### Request Flow
1. Android app calls middleware endpoints
2. Middleware forwards requests to master site
3. Master site responds with version information
4. Middleware forwards response back to app
5. App processes version information and shows appropriate dialogs

## Benefits

1. **Consistent Architecture**: All API calls go through middleware
2. **Centralized Logging**: Version check requests are logged in middleware
3. **Error Handling**: Unified error handling and response formatting
4. **Scalability**: Can add caching, rate limiting, or other middleware features
5. **Monitoring**: Easier to monitor and debug version check requests

## Deployment

### Vercel Deployment
The changes are compatible with Vercel serverless deployment:
- No database changes required
- Uses existing axios dependency
- Follows existing error handling patterns
- Compatible with CORS configuration

### Update Steps
1. Deploy updated middleware to Vercel
2. Ensure master site AppVersionController is accessible
3. Test endpoints with curl or Postman
4. Update and deploy Android app with new RetrofitClient configuration
5. Monitor logs for any issues

## Troubleshooting

### Common Issues
1. **502/503 errors**: Check if master site is accessible
2. **Timeout errors**: Verify network connectivity between Vercel and master site
3. **CORS issues**: Ensure CORS headers are properly configured
4. **Authentication**: Verify if master site requires authentication

### Logs to Monitor
- Middleware console logs for request/response data
- Master site logs for incoming version check requests
- Android app logs for API response handling
- Vercel function logs for deployment issues

## Security Considerations

1. **No Authentication Required**: Version check endpoints are public
2. **Rate Limiting**: Consider implementing rate limiting if needed
3. **Input Validation**: Validate version strings in requests
4. **HTTPS Only**: Ensure all communication uses HTTPS
5. **Error Information**: Be careful not to expose sensitive information in error responses