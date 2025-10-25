const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { auth } = require('../middleware/authMiddleware');
const Conversation = require('../models/Conversation');
const Reminder = require('../models/reminderModel');
const User = require('../models/userModel');

const { suggestFullScheduleWithGemini } = require('../services/geminiService');

// Initialize Google's Generative AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

// System prompt for the AI assistant
const SYSTEM_PROMPT = `You are Bela, a helpful AI assistant for the Beela AI reminder app. 
Your main functions are:
1. Answer general questions helpfully and concisely
2. Help users create tasks and meetings
3. Provide productivity tips and suggestions

When creating tasks or meetings, you should:
- Ask for any missing information (title, time, date, etc.)
- Confirm details before creating
- Be friendly and professional in all responses`;

// Chat with the AI assistant
router.post('/chat', auth, async (req, res) => {
  console.log('\n--- New Chat Request ---');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  console.log('User:', req.user);
  try {
    const { message } = req.body;
    const userId = req.user?.id || req.user?._id;

    // Get or create conversation
    let conversation = await Conversation.findOne({ userId });
    if (!conversation) {
      conversation = new Conversation({
        userId,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }]
      });
    }

    // Add user message to conversation
    conversation.messages.push({ role: 'user', content: message });
    
    // Check for pending action first
    if (conversation.pendingAction && conversation.pendingAction.type) {
      console.log('🔔 Pending action exists:', JSON.stringify(conversation.pendingAction, null, 2));
      console.log('🔔 Handling user response:', message);
      const result = await handlePendingAction(conversation, message, userId, req.user);
      if (result) {
        // Save assistant's response to conversation
        conversation.messages.push({ role: 'assistant', content: result.response });
        await conversation.save();
        console.log('✅ Response sent and conversation saved');
        return res.json(result);
      }
    }
const lastAssistantResponse =
  conversation.messages[conversation.messages.length - 1]?.content || '';
    // Detect action from the message
    const action = await detectAction(lastAssistantResponse, message, userId);
    
    if (action) {
      console.log('🔍 Action detected:', { type: action.type, confirmationNeeded: action.confirmationNeeded });
      
      // If we need more info, ask for it
      if (action.needsMoreInfo) {
        conversation.pendingAction = {
          type: action.type,
          data: action.data,
          missingFields: action.missingFields
        };
        await conversation.save();
        
        return res.json({
          success: true,
          response: action.question,
          action: 'needs_info',
          data: { missingFields: action.missingFields }
        });
      }
      
      // If we have all info, confirm before creating
      if (action.confirmationNeeded) {
        conversation.pendingAction = {
          type: action.type,
          data: action.data,
          confirmationNeeded: true
        };
        await conversation.save();
        
        console.log('💾 Pending action saved to conversation:', conversation.pendingAction);
        
        return res.json({
          success: true,
          response: action.confirmationMessage,
          action: 'confirm_action',
          data: action.data
        });
      }
    }

    // If no action or confirmation needed, proceed with normal chat
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const chat = model.startChat({
      history: conversation.messages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      }))
    });

    // Get response from Gemini
    const result = await chat.sendMessage(message);
    const response = await result.response;
    const responseText = response.text();

    // Save assistant's response
    conversation.messages.push({ role: 'assistant', content: responseText });
    await conversation.save();

    res.json({
      success: true,
      response: responseText
    });

  } catch (error) {
    console.error('Error in chat endpoint:', error);
     console.error('\n--- Error in /chat endpoint ---');
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code
    });
   res.status(500).json({
      success: false,
      message: 'Error processing your request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get conversation history
router.get('/conversation', auth, async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ userId: req.user.id });
    if (!conversation) {
      return res.json({ messages: [] });
    }
    res.json({ messages: conversation.messages });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching conversation',
      error: error.message
    });
  }
});

// Clear conversation history
router.delete('/conversation', auth, async (req, res) => {
  try {
    await Conversation.deleteOne({ userId: req.user.id });
    res.json({ success: true, message: 'Conversation cleared' });
  } catch (error) {
    console.error('Error clearing conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Error clearing conversation',
      error: error.message
    });
  }
});

// Helper function to use Gemini to intelligently detect user intent and extract details
async function detectActionWithGemini(userMessage, userId) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const currentDate = new Date(); // October 25, 2025 based on context
    const prompt = `You are an intelligent assistant that analyzes user messages to detect scheduling intents.

Current date and time: ${currentDate.toISOString()} (${currentDate.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' })})

Analyze this user message: "${userMessage}"

Your task:
1. Detect if the user wants to create a TASK or MEETING, or neither
2. Extract ALL details from the message (title, date, time, duration, recurrence, description)
3. Calculate the EXACT date and time based on relative terms (tomorrow, next week, etc.)
4. Identify any missing required information

Return a JSON object with this EXACT structure:
{
  "intent": "task" | "meeting" | "none",
  "data": {
    "title": "extracted or generated title from user intent",
    "description": "full user message or extracted description",
    "startDateISO": "YYYY-MM-DDTHH:mm:ss.sssZ (exact ISO date-time, required)",
    "duration": number (in minutes, for meetings, default 30),
    "isRoutine": boolean (true if daily/weekly/monthly pattern),
    "isRecurring": boolean (for meetings),
    "scheduleType": "one-day" | "routine" | "specific-days",
    "scheduleDays": ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] (if routine/recurring),
    "scheduleTime": {
      "fixedTime": "HH:mm" or null,
      "minutesBeforeStart": number (default 15 for tasks, 10 for meetings)
    }
  },
  "missingFields": ["field1", "field2"] (array of missing required fields),
  "confidence": number (0-100, how confident you are about the detection)
}

CRITICAL RULES:
- If user says "tomorrow", calculate from current date (${currentDate.toLocaleDateString()})
- If user says "tomorrow 5pm" = ${new Date(currentDate.getTime() + 24*60*60*1000).toLocaleDateString()} at 17:00
- If user says "next Monday" = calculate the next Monday from today
- ALWAYS provide a title - create one from the user's intent if not explicitly stated
- For time: convert "5pm" to "17:00", "9am" to "09:00"
- If no time specified for task, use scheduleTime.minutesBeforeStart instead of fixedTime
- If time IS specified, use scheduleTime.fixedTime with HH:mm format
- Mark field as missing ONLY if it's required and truly cannot be inferred
- Be smart: "team standup tomorrow" = title: "Team Standup", date: tomorrow at 09:00 (typical standup time)

Examples:
"Create task for tomorrow 5pm" → startDateISO: "${new Date(new Date(currentDate).setDate(currentDate.getDate() + 1)).toISOString().split('T')[0]}T17:00:00.000Z"
"Meeting next Monday at 2pm" → calculate next Monday from ${currentDate.toLocaleDateString()}, set time to 14:00
"Daily standup at 9am" → isRoutine: true, scheduleType: "routine", scheduleDays: ["MO","TU","WE","TH","FR"], fixedTime: "09:00"

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    
    // Remove markdown code blocks if present
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Gemini Intent Detection Response:', jsonText);
    
    const analysis = JSON.parse(jsonText);
    
    // If confidence is too low or no intent detected, return null
    if (analysis.intent === 'none' || analysis.confidence < 50) {
      return null;
    }
    
    return analysis;
    
  } catch (error) {
    console.error('Error in Gemini intent detection:', error);
    return null;
  }
}

// Helper function to detect actions in the conversation
async function detectAction(assistantResponse, userMessage, userId) {
  console.log('🔍 Detecting action for message:', userMessage);
  
  // Use Gemini for intelligent intent detection
  const geminiAnalysis = await detectActionWithGemini(userMessage, userId);
  
  if (!geminiAnalysis || geminiAnalysis.intent === 'none') {
    console.log('❌ No action detected by Gemini');
    return null;
  }
  
  console.log('✅ Gemini detected intent:', geminiAnalysis.intent);
  console.log('📊 Extracted data:', JSON.stringify(geminiAnalysis.data, null, 2));
  console.log('⚠️ Missing fields:', geminiAnalysis.missingFields);
  
  // Check if we have missing required fields
  if (geminiAnalysis.missingFields && geminiAnalysis.missingFields.length > 0) {
    const actionType = geminiAnalysis.intent === 'task' ? 'create_task' : 'schedule_meeting';
    
    return {
      type: actionType,
      data: geminiAnalysis.data,
      needsMoreInfo: true,
      missingFields: geminiAnalysis.missingFields,
      question: generateMissingFieldsQuestion(geminiAnalysis.missingFields, geminiAnalysis.data)
    };
  }
  
  // We have all required info, prepare for confirmation
  if (geminiAnalysis.intent === 'task') {
    const taskData = {
      title: geminiAnalysis.data.title,
      description: geminiAnalysis.data.description || userMessage,
      scheduleType: geminiAnalysis.data.scheduleType || 'one-day',
      startDateISO: geminiAnalysis.data.startDateISO,
      scheduleDays: geminiAnalysis.data.scheduleDays || [],
      scheduleTime: geminiAnalysis.data.scheduleTime || { minutesBeforeStart: 15, fixedTime: null },
      isRoutine: geminiAnalysis.data.isRoutine || false
    };

    const confirmation = await prepareActionConfirmation('create_task', taskData, userId);

    return {
      type: 'create_task',
      data: confirmation.data,
      confirmationNeeded: true,
      confirmationMessage: confirmation.confirmationMessage
    };
  } 
  
  if (geminiAnalysis.intent === 'meeting') {
    const startDate = new Date(geminiAnalysis.data.startDateISO);
    const duration = geminiAnalysis.data.duration || 30;
    const endDate = new Date(startDate.getTime() + duration * 60000);
    
    const meetingData = {
      title: geminiAnalysis.data.title,
      description: geminiAnalysis.data.description || userMessage,
      startTime: geminiAnalysis.data.startDateISO,
      endTime: endDate.toISOString(),
      duration: duration,
      isRecurring: geminiAnalysis.data.isRecurring || false,
      recurrencePattern: geminiAnalysis.data.isRecurring && geminiAnalysis.data.scheduleDays 
        ? `FREQ=WEEKLY;BYDAY=${geminiAnalysis.data.scheduleDays.join(',')}`
        : null,
      scheduleTime: geminiAnalysis.data.scheduleTime || { minutesBeforeStart: 10, fixedTime: null }
    };

    const confirmation = await prepareActionConfirmation('schedule_meeting', meetingData, userId);

    return {
      type: 'schedule_meeting',
      data: confirmation.data,
      confirmationNeeded: true,
      confirmationMessage: confirmation.confirmationMessage
    };
  }
  
  return null;
}

// Helper function to generate a friendly question for missing fields
function generateMissingFieldsQuestion(missingFields, extractedData) {
  const fieldMap = {
    title: 'a title or name',
    startDateISO: 'a date and time',
    duration: 'a duration (how long)',
    description: 'more details or description'
  };
  
  let extracted = [];
  if (extractedData.title) extracted.push(`"${extractedData.title}"`);
  if (extractedData.startDateISO) {
    const date = new Date(extractedData.startDateISO);
    extracted.push(`on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`);
  }
  
  const missingList = missingFields.map(f => fieldMap[f] || f).join(' and ');
  
  let message = '';
  if (extracted.length > 0) {
    message = `I understand you want to create ${extracted.join(' ')}. `;
  }
  
  message += `Could you please provide ${missingList}?`;
  
  return message;
}

// Helper function to handle pending actions (confirmations, missing info)
async function handlePendingAction(conversation, message, userId, userObj) {
  const pendingAction = conversation.pendingAction;
  const lowerMessage = message.toLowerCase();
  
  console.log('📋 handlePendingAction called with:', {
    pendingActionType: pendingAction?.type,
    confirmationNeeded: pendingAction?.confirmationNeeded,
    message: message,
    userId: userId
  });
  
  // Check if this is a confirmation
  if (pendingAction.confirmationNeeded) {
    console.log('🤔 Checking user confirmation. Message:', lowerMessage);
    
    if (isAffirmative(lowerMessage)) {
      console.log('✅ User confirmed! Creating item...');
      // User confirmed, create the item
      try {
        let createdItem;
        let responseMessage;
        
        // Create task or meeting based on type
        if (pendingAction.type === 'create_task') {
          console.log('🔄 Attempting to create task with data:', { 
            data: pendingAction.data,
            userId 
          });
          createdItem = await createTask(pendingAction.data, userId);
          console.log('✅ Task created successfully:', createdItem);
          responseMessage = `✅ Task "${createdItem.title}" has been created successfully!`;
          
        } else if (pendingAction.type === 'schedule_meeting') {
          console.log('🔄 Attempting to create meeting with data:', { 
            data: pendingAction.data,
            userId 
          });
          createdItem = await createMeeting(pendingAction.data, userId);
          console.log('✅ Meeting created successfully:', createdItem);
          responseMessage = `✅ Meeting "${createdItem.title}" has been scheduled successfully!`;
        }
        
        // Clear pending action
        conversation.pendingAction = null;
        await conversation.save();
        
        return {
          success: true,
          response: responseMessage,
          action: `${pendingAction.type}_success`,
          data: createdItem
        };
        
      } catch (error) {
        console.error('Error creating item:', error);
        return {
          success: false,
          response: `Sorry, I couldn't create that. ${error.message}`,
          action: 'creation_failed'
        };
      }
    } else if (isNegative(lowerMessage)) {
      console.log('❌ User declined the action');
      // User declined
      conversation.pendingAction = null;
      await conversation.save();
      return {
        success: true,
        response: "Okay, I won't create that. Is there anything else I can help with?",
        action: 'action_cancelled'
      };
    } else {
      // User wants to make changes - use Gemini to detect what they want to change
      console.log('🔧 User wants to make changes. Detecting modifications...');
      
      const modifications = await detectModificationsWithGemini(
        message,
        pendingAction.data,
        pendingAction.type
      );
      
      if (modifications.hasChanges) {
        console.log('✏️ Changes detected:', JSON.stringify(modifications.updatedData, null, 2));
        
        // Update pending action with modified data
        conversation.pendingAction.data = modifications.updatedData;
        await conversation.save();
        
        // Re-confirm with updated details
        const confirmation = await prepareActionConfirmation(
          pendingAction.type,
          modifications.updatedData,
          userId
        );
        
        return {
          success: true,
          response: `Got it! I've updated the details. ${confirmation.confirmationMessage}`,
          action: 'confirm_action',
          data: modifications.updatedData
        };
      } else {
        // Couldn't detect changes, re-prompt for confirmation
        console.log('⚠️ User response unclear, re-prompting for confirmation');
        return {
          success: true,
          response: "I didn't quite catch that. Would you like me to create this? Please say 'yes' to confirm, 'no' to cancel, or tell me what you'd like to change.",
          action: 'awaiting_confirmation',
          data: pendingAction.data
        };
      }
    }
  }
  
  // Handle missing information
  if (pendingAction.missingFields && pendingAction.missingFields.length > 0) {
    console.log('📝 Handling missing fields with Gemini. Missing:', pendingAction.missingFields);
    
    // Use Gemini to extract missing information from user's response
    const extractedInfo = await extractMissingFieldsWithGemini(
      message, 
      pendingAction.missingFields, 
      pendingAction.data,
      pendingAction.type
    );
    
    console.log('🤖 Gemini extracted info:', JSON.stringify(extractedInfo, null, 2));
    
    const updatedData = { ...pendingAction.data, ...extractedInfo.extractedData };
    
    if (extractedInfo.allFieldsFilled) {
      console.log('✅ All fields filled! Preparing confirmation...');
      // All missing fields are now filled, confirm before creating
      const action = await prepareActionConfirmation(
        pendingAction.type,
        updatedData,
        userId
      );
      
      conversation.pendingAction = {
        type: pendingAction.type,
        data: updatedData,
        confirmationNeeded: true
      };
      
      await conversation.save();
      
      return {
        success: true,
        response: action.confirmationMessage,
        action: 'confirm_action',
        data: updatedData
      };
    } else {
      console.log('⚠️ Still missing fields:', extractedInfo.remainingFields);
      // Still missing some fields, ask for them
      conversation.pendingAction.data = updatedData;
      conversation.pendingAction.missingFields = extractedInfo.remainingFields;
      await conversation.save();
      
      return {
        success: true,
        response: generateMissingFieldsQuestion(extractedInfo.remainingFields, updatedData),
        action: 'needs_info',
        data: { 
          missingFields: extractedInfo.remainingFields,
          extractedFields: extractedInfo.extractedData
        }
      };
    }
  }
  
  return null;
}

// Helper function to use Gemini to detect modifications user wants to make
async function detectModificationsWithGemini(userMessage, currentData, actionType) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const currentDate = new Date(); // October 25, 2025
    
    const prompt = `You are helping detect modifications a user wants to make to a scheduled item.

Current date and time: ${currentDate.toISOString()} (${currentDate.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' })})

Action type: ${actionType === 'create_task' ? 'Task' : 'Meeting'}

Current item details: ${JSON.stringify(currentData, null, 2)}

User's modification request: "${userMessage}"

Analyze what the user wants to change. They might want to:
- Change the title
- Change the date/time
- Change the duration
- Change recurrence settings
- Change other details

Return a JSON object with this EXACT structure:
{
  "hasChanges": boolean (true if user wants to make changes),
  "updatedData": {
    // Include ALL fields from currentData, with modifications applied
    // Calculate exact dates for relative terms like "change to tomorrow 6pm"
    // Keep unchanged fields as they are
  },
  "changesSummary": "brief description of what was changed"
}

CRITICAL RULES:
- If user says "change time to 6pm", update scheduleTime.fixedTime to "18:00"
- If user says "make it tomorrow", calculate tomorrow's date from ${currentDate.toLocaleDateString()}
- If user says "change title to X", update title to "X"
- If user says "make it 1 hour" or "45 minutes", update duration
- Keep ALL other fields unchanged from currentData
- Calculate exact ISO dates for any date/time changes
- If you can't detect any specific change request, set hasChanges to false

Examples:
"Change time to 6pm" → update scheduleTime.fixedTime or startDateISO time portion
"Make it tomorrow" → update startDateISO to tomorrow's date
"Change title to Team Meeting" → update title
"Make it 45 minutes" → update duration to 45

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Gemini Modification Detection:', jsonText);
    
    const modifications = JSON.parse(jsonText);
    
    return modifications;
    
  } catch (error) {
    console.error('Error in Gemini modification detection:', error);
    return {
      hasChanges: false,
      updatedData: currentData,
      changesSummary: ''
    };
  }
}

// Helper function to use Gemini to extract missing field information
async function extractMissingFieldsWithGemini(userMessage, missingFields, existingData, actionType) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const currentDate = new Date(); // October 25, 2025
    
    const prompt = `You are helping extract missing information from a user's response.

Current date and time: ${currentDate.toISOString()} (${currentDate.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' })})

Action type: ${actionType === 'create_task' ? 'Creating a Task' : 'Scheduling a Meeting'}

Existing data: ${JSON.stringify(existingData, null, 2)}

Missing fields needed: ${JSON.stringify(missingFields)}

User's response: "${userMessage}"

Extract the missing field values from the user's message. Calculate exact dates and times based on relative terms.

Return a JSON object with this EXACT structure:
{
  "extractedData": {
    "title": "extracted title if missing",
    "startDateISO": "YYYY-MM-DDTHH:mm:ss.sssZ (exact ISO datetime)",
    "duration": number (minutes),
    "description": "extracted description"
  },
  "allFieldsFilled": boolean (true if all missing fields are now filled),
  "remainingFields": ["field1", "field2"] (fields still missing)
}

CRITICAL RULES:
- Only include fields in extractedData that were in the missingFields list
- Calculate exact dates: "tomorrow 5pm" from ${currentDate.toLocaleDateString()} = ${new Date(currentDate.getTime() + 24*60*60*1000).toLocaleDateString()} at 17:00:00
- Convert times: "5pm" = "17:00", "9am" = "09:00"
- If user says "tomorrow" without time for a task, provide startDateISO for tomorrow at 00:00 (time will be set via scheduleTime)
- If user says "tomorrow 3pm" for a meeting/task, provide exact datetime
- Be smart and infer reasonable values when possible
- Only mark as remaining if truly cannot be extracted or inferred

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Gemini Missing Fields Extraction:', jsonText);
    
    const extraction = JSON.parse(jsonText);
    
    return extraction;
    
  } catch (error) {
    console.error('Error in Gemini field extraction:', error);
    // Fallback: return empty extraction
    return {
      extractedData: {},
      allFieldsFilled: false,
      remainingFields: missingFields
    };
  }
}

// Helper function to check if user response is affirmative
function isAffirmative(message) {
  const trimmed = message.trim().toLowerCase();
  // Check for common affirmative responses (with word boundaries to allow phrases)
  return /\b(yes|yeah|yep|sure|ok|okay|confirm|yup|correct|right|go ahead|do it|create|schedule|proceed)\b/i.test(trimmed);
}

// Helper function to check if user response is negative
function isNegative(message) {
  const trimmed = message.trim().toLowerCase();
  // Check for common negative responses
  return /\b(no|nope|nah|cancel|stop|don't|do not|never mind|forget it|abort)\b/i.test(trimmed);
}

// Helper function to prepare action confirmation
async function prepareActionConfirmation(type, data, userId) {
  if (type === 'create_task') {
    // Format the date and time for user-friendly display
    let scheduleInfo = '';
    
    if (data.startDateISO) {
      const startDate = new Date(data.startDateISO);
      const dateStr = startDate.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
      
      if (data.scheduleTime?.fixedTime) {
        scheduleInfo = ` on ${dateStr} at ${data.scheduleTime.fixedTime}`;
      } else {
        const timeStr = startDate.toLocaleTimeString('en-US', { 
          hour: 'numeric', 
          minute: '2-digit',
          hour12: true 
        });
        scheduleInfo = ` on ${dateStr} at ${timeStr}`;
      }
    } else if (data.scheduleTime?.fixedTime) {
      scheduleInfo = ` at ${data.scheduleTime.fixedTime}`;
    }
    
    let reminderInfo = '';
    if (data.scheduleTime?.minutesBeforeStart && !data.scheduleTime.fixedTime) {
      reminderInfo = ` (${data.scheduleTime.minutesBeforeStart} min reminder)`;
    }
    
    const routineInfo = data.isRoutine ? ' (Routine task)' : '';
    const daysInfo = data.scheduleDays && data.scheduleDays.length > 0 
      ? ` - Repeats: ${data.scheduleDays.join(', ')}` 
      : '';
    
    let detailedMessage = `📋 Task Details:\n`;
    detailedMessage += `• Title: "${data.title}"\n`;
    if (scheduleInfo) detailedMessage += `• Scheduled:${scheduleInfo}${reminderInfo}\n`;
    if (daysInfo) detailedMessage += `• ${daysInfo.trim()}\n`;
    if (routineInfo) detailedMessage += `• Type:${routineInfo}\n`;
    if (data.description && data.description !== data.title) {
      detailedMessage += `• Description: ${data.description}\n`;
    }
    detailedMessage += `\nShould I create this task? (Yes/No, or tell me what to change)`;
      
    return {
      confirmationMessage: detailedMessage,
      data
    };
    
  } else if (type === 'schedule_meeting') {
    // Format meeting date and time
    let scheduleInfo = '';
    
    if (data.startTime) {
      const startDate = new Date(data.startTime);
      const dateStr = startDate.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
      const timeStr = startDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
      scheduleInfo = `${dateStr} at ${timeStr}`;
    }
    
    const durationInfo = data.duration ? `${data.duration} minutes` : '30 minutes';
    const recurrenceInfo = data.isRecurring ? 'Yes' : 'No';
    
    let detailedMessage = `📅 Meeting Details:\n`;
    detailedMessage += `• Title: "${data.title}"\n`;
    if (scheduleInfo) detailedMessage += `• When: ${scheduleInfo}\n`;
    detailedMessage += `• Duration: ${durationInfo}\n`;
    detailedMessage += `• Recurring: ${recurrenceInfo}\n`;
    if (data.description && data.description !== data.title) {
      detailedMessage += `• Description: ${data.description}\n`;
    }
    detailedMessage += `\nShould I schedule this meeting? (Yes/No, or tell me what to change)`;
    
    return {
      confirmationMessage: detailedMessage,
      data
    };
  }
  
  return { confirmationMessage: 'Should I proceed with this?', data };
}

// Helper function to generate a friendly question for missing fields
function generateMissingFieldsQuestion(missingFields, extractedData) {
  const fieldMap = {
    title: 'a title or name',
    startDateISO: 'a date and time',
    duration: 'a duration (how long)',
    description: 'more details or description'
  };
  
  let extracted = [];
  if (extractedData.title) extracted.push(`"${extractedData.title}"`);
  if (extractedData.startDateISO) {
    const date = new Date(extractedData.startDateISO);
    extracted.push(`on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`);
  }
  
  const missingList = missingFields.map(f => fieldMap[f] || f).join(' and ');
  
  let message = '';
  if (extracted.length > 0) {
    message = `I understand you want to create ${extracted.join(' ')}. `;
  }
  
  message += `Could you please provide ${missingList}?`;
  
  return message;
}

// Helper function to create a task in the database
async function createTask(taskData, userId) {
  console.log('📝 Creating task with data:', JSON.stringify({ taskData, userId }, null, 2));
  
  // Prepare reminder data matching the reminderModel schema
  const reminderData = {
    user: userId,
    type: 'Task',
    title: taskData.title,
    description: taskData.description || '',
    startDate: taskData.startDateISO ? new Date(taskData.startDateISO) : null,
    isCompleted: false,
    isManualSchedule: taskData.scheduleType === 'routine' ? true : (taskData.startDateISO ? true : false),
    aiSuggested: true,
    scheduleType: taskData.scheduleType || 'one-day',
    scheduleTime: taskData.scheduleTime || { minutesBeforeStart: 15, fixedTime: null },
    scheduleDays: taskData.scheduleDays || [],
    notificationPreferenceMinutes: taskData.scheduleTime?.minutesBeforeStart || 15,
    icon: 'star'
  };
  
  console.log('💾 Prepared reminder data:', JSON.stringify(reminderData, null, 2));
  
  try {
    const task = new Reminder(reminderData);
    const savedTask = await task.save();
    console.log('✅ Task saved to database with ID:', savedTask._id);
    console.log('✅ Full saved task:', JSON.stringify(savedTask.toObject(), null, 2));
    return savedTask;
  } catch (error) {
    console.error('❌ Error saving task to database:', {
      error: error.message,
      stack: error.stack,
      validationErrors: error.errors,
      reminderData: reminderData
    });
    throw error;
  }
}

// Helper function to create a meeting in the database
async function createMeeting(meetingData, userId) {
  console.log('📅 Creating meeting with data:', JSON.stringify({ meetingData, userId }, null, 2));
  
  try {
    const duration = meetingData.duration || 30;
    const startDate = meetingData.startTime ? new Date(meetingData.startTime) : new Date();
    const endDate = new Date(startDate.getTime() + duration * 60000);

    const reminderData = {
      type: 'Meeting',
      user: userId,
      title: meetingData.title,
      description: meetingData.description || '',
      startDate,
      endDate,
      isManualSchedule: true,
      scheduleType: 'one-day',
      scheduleTime: meetingData.scheduleTime || { minutesBeforeStart: 10 },
      notificationPreferenceMinutes: 10,
      aiSuggested: true,
      icon: 'star'
    };

    console.log('💾 Prepared meeting reminder data:', JSON.stringify(reminderData, null, 2));

    const meeting = new Reminder(reminderData);
    const saved = await meeting.save();
    console.log('✅ Meeting saved to database with ID:', saved._id);
    console.log('✅ Full saved meeting:', JSON.stringify(saved.toObject(), null, 2));
    return saved;
  } catch (err) {
    console.error('❌ Meeting Save Error:', {
      error: err.message,
      stack: err.stack,
      validationErrors: err.errors,
      meetingData: meetingData
    });
    throw err;
  }
}

module.exports = router;
async function createTask(taskData, userId) {
  console.log('📝 Creating task with data:', JSON.stringify({ taskData, userId }, null, 2));
  
  // Prepare reminder data matching the reminderModel schema
  const reminderData = {
    user: userId,
    type: 'Task',
    title: taskData.title,
    description: taskData.description || '',
    startDate: taskData.startDateISO ? new Date(taskData.startDateISO) : null,
    isCompleted: false,
    isManualSchedule: taskData.scheduleType === 'routine' ? true : (taskData.startDateISO ? true : false),
    aiSuggested: true,
    scheduleType: taskData.scheduleType || 'one-day',
    scheduleTime: taskData.scheduleTime || { minutesBeforeStart: 15, fixedTime: null },
    scheduleDays: taskData.scheduleDays || [],
    notificationPreferenceMinutes: taskData.scheduleTime?.minutesBeforeStart || 15,
    icon: 'star'
  };
  
  console.log('💾 Prepared reminder data:', JSON.stringify(reminderData, null, 2));
  
  try {
    const task = new Reminder(reminderData);
    const savedTask = await task.save();
    console.log('✅ Task saved to database with ID:', savedTask._id);
    console.log('✅ Full saved task:', JSON.stringify(savedTask.toObject(), null, 2));
    return savedTask;
  } catch (error) {
    console.error('❌ Error saving task to database:', {
      error: error.message,
      stack: error.stack,
      validationErrors: error.errors,
      reminderData: reminderData
    });
    throw error;
  }
}

// Helper function to create a meeting in the database
async function createMeeting(meetingData, userId) {
  console.log('📅 Creating meeting with data:', JSON.stringify({ meetingData, userId }, null, 2));
  
  try {
    const duration = meetingData.duration || 30;
    const startDate = meetingData.startTime ? new Date(meetingData.startTime) : new Date();
    const endDate = new Date(startDate.getTime() + duration * 60000);

    const reminderData = {
      type: 'Meeting',
      user: userId,
      title: meetingData.title,
      description: meetingData.description || '',
      startDate,
      endDate,
      isManualSchedule: true,
      scheduleType: 'one-day',
      scheduleTime: { minutesBeforeStart: 10 },
      notificationPreferenceMinutes: 10,
      aiSuggested: true,
      icon: 'star'
    };

    console.log('💾 Prepared meeting reminder data:', JSON.stringify(reminderData, null, 2));

    const meeting = new Reminder(reminderData);
    const saved = await meeting.save();
    console.log('✅ Meeting saved to database with ID:', saved._id);
    console.log('✅ Full saved meeting:', JSON.stringify(saved.toObject(), null, 2));
    return saved;
  } catch (err) {
    console.error('❌ Meeting Save Error:', {
      error: err.message,
      stack: err.stack,
      validationErrors: err.errors,
      meetingData: meetingData
    });
    throw err;
  }
}


// Helper function to generate message for missing fields
function getMissingFieldsMessage(missingFields, extractedFields = {}) {
  const fieldNames = {
    title: 'title',
    time: 'time',
    date: 'date',
    duration: 'duration',
    description: 'description'
  };
  
  const fieldsList = missingFields.map(f => fieldNames[f] || f).join(', ');
  const extractedInfo = [];
  
  // Add any already extracted fields to the message
  if (extractedFields.title) extractedInfo.push(`Title: ${extractedFields.title}`);
  if (extractedFields.time) extractedInfo.push(`Time: ${extractedFields.time}`);
  if (extractedFields.date) extractedInfo.push(`Date: ${extractedFields.date}`);
  if (extractedFields.duration) extractedInfo.push(`Duration: ${extractedFields.duration} minutes`);
  
  let message = '';
  if (extractedInfo.length > 0) {
    message += `I have ${extractedInfo.join(', ')}. `;
  }
  
  message += `I need a few more details to create this. Could you please provide the ${fieldsList}?`;
  
  return message;
}

module.exports = router;