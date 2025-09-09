const { google } = require('googleapis');
const { OAuth2 } = google.auth;
const Calendar = require('../models/calendarModel');
const User = require('../models/userModel');
const Reminder = require('../models/reminderModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const jwt = require('jsonwebtoken');

// Initialize Google OAuth2 client
const oauth2Client = new OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Generate Google OAuth URL
const getAuthUrl = catchAsync(async (req, res) => {
  console.log('Generating Google OAuth URL...');
  console.log('Client ID:', process.env.GOOGLE_CLIENT_ID ? 'Present' : 'Missing');
  console.log('Redirect URI:', process.env.GOOGLE_REDIRECT_URI);

  try {
    // Get the authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Please provide a valid token', 401);
    }
    const token = authHeader.split(' ')[1];

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events',
        // Include read-only Google Tasks scope so we can show tasks in CalendarScreen tabs
        'https://www.googleapis.com/auth/tasks.readonly'
      ],
      include_granted_scopes: true,
      prompt: 'consent',
      state: token // Include the JWT token in the state parameter
    });

    console.log('Generated Auth URL:', url);
    
    res.status(200).json({
      status: 'success',
      data: {
        url
      }
    });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    throw error;
  }
});

// Handle Google OAuth callback
const handleCallback = catchAsync(async (req, res, next) => {
  const { code, state: token } = req.query;
  
  if (!code) {
    return next(new AppError('Authorization code is required', 400));
  }

  try {
    // Verify the token from state parameter
    if (!token) {
      return res.status(400).send(`<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Error</title></head>
          <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
            <p>Authentication token missing</p>
            <script>setTimeout(function(){window.close();},500);</script>
          </body>
        </html>`);
    }

    // Verify the token and get the user
    let user;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user = await User.findById(decoded.id);
      
      if (!user) {
        return res.status(400).send(`<!doctype html>
          <html>
            <head><meta charset="utf-8"><title>Error</title></head>
            <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
              <p>User not found</p>
              <script>setTimeout(function(){window.close();},500);</script>
            </body>
          </html>`);
      }
    } catch (err) {
      console.error('Token verification error:', err);
      return res.status(400).send(`<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Error</title></head>
          <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
            <p>Invalid or expired token</p>
            <script>setTimeout(function(){window.close();},500);</script>
          </body>
        </html>`);
    }

    try {
      // Exchange the code for tokens
      const { tokens } = await oauth2Client.getToken(code);
      
      if (!tokens.access_token) {
        throw new Error('Failed to obtain access token from Google');
      }

      // Get user's calendar events
      oauth2Client.setCredentials(tokens);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      let events = [];
      try {
        const eventsResponse = await calendar.events.list({
          calendarId: 'primary',
          // Fetch a reasonable window into the past to include historical items
          timeMin: new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString(),
          maxResults: 250,
          singleEvents: true,
          orderBy: 'startTime',
        });
        events = eventsResponse.data.items || [];
      } catch (calendarError) {
        console.warn('Could not fetch initial events:', calendarError.message);
        // Continue without events - user can sync later
      }

      // Save the tokens and calendar data (schema expects top-level fields)
      const calendarData = {
        user: user._id,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiry: new Date(tokens.expiry_date),
        events: events,
        lastSynced: new Date()
      };

      // Update or create calendar data
      await Calendar.findOneAndUpdate(
        { user: user._id },
        calendarData,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Finish the auth session by rendering a minimal HTML page that closes the browser tab/webview
      return res.status(200).send(`<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Connected</title></head>
          <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
            <p>Google Calendar connected successfully. You can close this window.</p>
            <script>
              (function(){
                try { window.opener && window.opener.postMessage('success','*'); } catch(e){}
                try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage('success'); } catch(e){}
                setTimeout(function(){ window.close(); }, 300);
              })();
            </script>
          </body>
        </html>`);
      
    } catch (error) {
      console.error('Error in OAuth flow:', error);
      return res.status(400).send(`<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Error</title></head>
          <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
            <p>Failed to connect Google Calendar: ${error.message}</p>
            <script>
              (function(){
                try { window.opener && window.opener.postMessage('error','*'); } catch(e){}
                try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage('error'); } catch(e){}
                setTimeout(function(){ window.close(); }, 500);
              })();
            </script>
          </body>
        </html>`);
    }
  } catch (error) {
    console.error('Error in handleCallback:', error);
    return res.status(500).send(`<!doctype html><html><body><p>Internal server error.</p><script>setTimeout(function(){window.close();},500);</script></body></html>`);
  }
});

// Sync calendar events (includes past events with pagination)
const syncCalendar = catchAsync(async (req, res, next) => {
  const { user } = req;
  
  const calendar = await Calendar.findOne({ user: user._id });
  if (!calendar) {
    return next(new AppError('Please connect your Google Calendar first', 400));
  }

  // Set credentials
  oauth2Client.setCredentials({
    access_token: calendar.accessToken,
    refresh_token: calendar.refreshToken,
    expiry_date: calendar.tokenExpiry && new Date(calendar.tokenExpiry).getTime()
  });

  // Refresh token if needed
  if (calendar.tokenExpiry && new Date() > new Date(calendar.tokenExpiry)) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    calendar.accessToken = credentials.access_token;
    calendar.tokenExpiry = new Date(credentials.expiry_date);
    await calendar.save();
  }

  // Get updated events (paginate and include past year)
  const calendarApi = google.calendar({ version: 'v3', auth: oauth2Client });
  const allEvents = [];
  let pageToken = undefined;
  const timeMin = new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString();
  do {
    const resp = await calendarApi.events.list({
      calendarId: 'primary',
      timeMin,
      maxResults: 2500, // Google API limit per page
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
    });
    if (resp.data.items && resp.data.items.length) {
      allEvents.push(...resp.data.items);
    }
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  // Update events
  calendar.events = allEvents;
  calendar.lastSynced = new Date();
  await calendar.save();

  res.status(200).json({
    status: 'success',
    data: {
      events: calendar.events,
      lastSynced: calendar.lastSynced
    }
  });
});

// Get unified calendar items: events from Google + tasks and meetings from reminders
const getCalendarItems = catchAsync(async (req, res, next) => {
  const { user } = req;

  // Fetch calendar (if connected) including tokens
  const calendar = await Calendar.findOne({ user: user._id })
    .select('events lastSynced accessToken refreshToken tokenExpiry');

  // Fetch reminders
  const reminders = await Reminder.find({ user: user._id })
    .select('type title description startDate endDate location isCompleted');

  // Attempt to fetch Google Tasks (if calendar connection exists and scope was granted)
  let googleTasks = [];
  if (calendar) {
    try {
      // Set credentials from stored tokens
      oauth2Client.setCredentials({
        access_token: calendar.accessToken,
        refresh_token: calendar.refreshToken,
        expiry_date: calendar.tokenExpiry && new Date(calendar.tokenExpiry).getTime()
      });

      // Refresh token if needed
      if (calendar.tokenExpiry && new Date() > new Date(calendar.tokenExpiry)) {
        const { credentials } = await oauth2Client.refreshAccessToken();
        calendar.accessToken = credentials.access_token;
        calendar.tokenExpiry = new Date(credentials.expiry_date);
        await calendar.save();
        oauth2Client.setCredentials({
          access_token: calendar.accessToken,
          refresh_token: calendar.refreshToken,
          expiry_date: new Date(calendar.tokenExpiry).getTime()
        });
      }
      const tasksApi = google.tasks({ version: 'v1', auth: oauth2Client });
      // List tasklists
      const listsResp = await tasksApi.tasklists.list({ maxResults: 10 });
      const lists = listsResp.data.items || [];
      for (const list of lists) {
        try {
          const tResp = await tasksApi.tasks.list({ tasklist: list.id, maxResults: 100, showCompleted: true });
          if (tResp.data.items && tResp.data.items.length) {
            googleTasks.push(...tResp.data.items.map(t => ({
              id: t.id,
              title: t.title,
              description: t.notes,
              startTime: t.due || t.updated, // Google Tasks may have only due date
              endTime: t.due || t.updated,
              location: '',
              status: t.status, // 'needsAction' | 'completed'
            })));
          }
        } catch (e) {
          // continue other lists
        }
      }
    } catch (e) {
      // If scope is missing or tokens invalid for tasks, ignore silently
    }
  }

  const tasks = reminders
    .filter(r => r.type === 'Task')
    .map(r => ({
      id: r._id,
      title: r.title,
      description: r.description,
      startTime: r.startDate,
      endTime: r.endDate,
      location: r.location?.name || '',
      status: r.isCompleted ? 'completed' : 'pending',
    }));

  const meetings = reminders
    .filter(r => r.type === 'Meeting')
    .map(r => ({
      id: r._id,
      title: r.title,
      description: r.description,
      startTime: r.startDate,
      endTime: r.endDate,
      location: r.location?.name || '',
    }));

  res.status(200).json({
    status: 'success',
    data: {
      events: calendar ? calendar.events : [],
      tasks: [...tasks, ...googleTasks],
      meetings,
      lastSynced: calendar ? calendar.lastSynced : null,
    }
  });
});

// Get user's calendar events
const getCalendarEvents = catchAsync(async (req, res, next) => {
  const { user } = req;
  
  const calendar = await Calendar.findOne({ user: user._id })
    .select('events lastSynced');

  if (!calendar) {
    return next(new AppError('No calendar found. Please sync your Google Calendar first.', 404));
  }

  res.status(200).json({
    status: 'success',
    data: {
      events: calendar.events,
      lastSynced: calendar.lastSynced
    }
  });
});

module.exports = {
  getAuthUrl,
  handleCallback,
  syncCalendar,
  getCalendarEvents,
  getCalendarItems
};