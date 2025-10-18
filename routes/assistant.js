const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { auth } = require('../middleware/authMiddleware');
const Conversation = require('../models/Conversation');
const Task = require('../models/Task');
const Meeting = require('../models/Meeting');
const { v4: uuidv4 } = require('uuid');
const { suggestFullScheduleWithGemini } = require('../services/geminiService');

// Initialize Google's Generative AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

// System prompt for the AI assistant
const SYSTEM_PROMPT = `You are Bela, a helpful AI assistant for the VoxaAI productivity app. 
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
  try {
    const { message } = req.body;
    const userId = req.user.id;

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
    if (conversation.pendingAction) {
      const result = await handlePendingAction(conversation, message, userId);
      if (result) {
        return res.json(result);
      }
    }

    // Detect action from the message
    const action = await detectAction(conversation.messages, message, userId);
    
    if (action) {
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
          confirmed: false
        };
        await conversation.save();
        
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
    res.status(500).json({
      success: false,
      message: 'Error processing your request',
      error: error.message
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

// Helper function to detect actions in the conversation
async function detectAction(assistantResponse, userMessage, userId) {
  const lowerResponse = assistantResponse.toLowerCase();
  const lowerMessage = userMessage.toLowerCase();
  
  // Extract task/meeting details using more comprehensive patterns
  const extractDetails = (message) => {
    // Extract title (more robust pattern)
    const titleMatch = /(?:title|name|call(?:ed|ing)|titled?|about|for|regarding|on)[\s:]+["']?([^"'.!?]+)["']?/i.exec(message) || 
                      /(?:create|add|new|schedule|set up)\s+(?:a\s+)?(?:meeting|task|appointment|reminder|event)[\s:]+["']?([^"'.!?]+)["']?/i.exec(message);
    
    // Extract time (supports 12h and 24h formats)
    const timeMatch = /(?:at|by|for|on)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/i.exec(message);
    
    // Extract date (supports relative and absolute dates)
    const dateMatch = /(?:on|for|due|scheduled for)?\s*(?:the\s*)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i.exec(message);
    
    // Extract duration (for meetings)
    const durationMatch = /(?:for|duration|length|time)[\s:]+(\d+)\s*(?:min|minutes?|h|hours?|hrs?)/i.exec(message);
    
    return {
      title: titleMatch ? (titleMatch[1] || titleMatch[2] || '').trim() : null,
      time: timeMatch ? timeMatch[1] : null,
      date: dateMatch ? dateMatch[1] : null,
      duration: durationMatch ? parseInt(durationMatch[1]) : 30 // Default to 30 minutes
    };
  };

  // Check for task creation intent
  if (lowerResponse.match(/\b(create|add|new|set up)\s+(?:a\s+)?(task|reminder|todo)\b/i) ||
      lowerMessage.match(/\b(create|add|new|set up)\s+(?:a\s+)?(task|reminder|todo)\b/i)) {
    
    const details = extractDetails(userMessage);
    const isRoutine = /\b(routine|daily|weekly|monthly|every day|each day|every\s+\w+day)\b/i.test(userMessage);
    
    try {
      // Use Gemini to suggest a schedule
      const schedule = await suggestFullScheduleWithGemini({
        userId,
        now: new Date(),
        item: {
          type: 'Task',
          title: details.title || 'Untitled Task',
          description: userMessage
        }
      });

      return {
        type: 'create_task',
        data: {
          title: details.title || 'New Task',
          description: userMessage,
          scheduleType: isRoutine ? 'routine' : 'one-day',
          startDateISO: schedule.startDateISO,
          scheduleDays: schedule.scheduleDays || [],
          scheduleTime: schedule.scheduleTime || { minutesBeforeStart: 15, fixedTime: null },
          isRoutine
        }
      };
    } catch (error) {
      console.error('Error suggesting schedule:', error);
      // Fallback to basic task creation if Gemini fails
      return {
        type: 'create_task',
        data: {
          title: details.title || 'New Task',
          description: userMessage,
          scheduleType: isRoutine ? 'routine' : 'one-day',
          isRoutine
        }
      };
    }
  }
  
  // Check for meeting creation intent
  if (lowerResponse.match(/\b(create|schedule|set up|new)\s+(?:a\s+)?(meeting|appointment|call|event)\b/i) ||
      lowerMessage.match(/\b(create|schedule|set up|new)\s+(?:a\s+)?(meeting|appointment|call|event)\b/i)) {
    
    const details = extractDetails(userMessage);
    const isRecurring = /\b(recurring|weekly|monthly|every week|each week|every month|bi[\s-]?weekly)\b/i.test(userMessage);
    
    try {
      // Use Gemini to suggest a schedule
      const schedule = await suggestFullScheduleWithGemini({
        userId,
        now: new Date(),
        item: {
          type: 'Meeting',
          title: details.title || 'Untitled Meeting',
          description: userMessage,
          duration: details.duration || 30
        }
      });

      return {
        type: 'schedule_meeting',
        data: {
          title: details.title || 'New Meeting',
          description: userMessage,
          startTime: schedule.startDateISO || new Date().toISOString(),
          endTime: new Date(new Date(schedule.startDateISO || new Date()).getTime() + (details.duration || 30) * 60000).toISOString(),
          isRecurring,
          recurrencePattern: isRecurring ? 'FREQ=WEEKLY;BYDAY=' + (schedule.scheduleDays?.join(',') || 'MO,WE,FR') : null
        }
      };
    } catch (error) {
      console.error('Error suggesting meeting schedule:', error);
      // Fallback to basic meeting creation if Gemini fails
      return {
        type: 'schedule_meeting',
        data: {
          title: details.title || 'New Meeting',
          description: userMessage,
          startTime: new Date().toISOString(),
          endTime: new Date(Date.now() + (details.duration || 30) * 60000).toISOString(),
          isRecurring
        }
      };
    }
  }
  
  return null;
}

// Helper function to handle pending actions (confirmations, missing info)
async function handlePendingAction(conversation, message, userId) {
  const pendingAction = conversation.pendingAction;
  const lowerMessage = message.toLowerCase();
  
  // Check if this is a confirmation
  if (pendingAction.confirmationNeeded) {
    if (isAffirmative(lowerMessage)) {
      // User confirmed, create the item
      try {
        let createdItem;
        let responseMessage;
        
        if (pendingAction.type === 'create_task') {
          createdItem = await createTask(pendingAction.data, userId);
          responseMessage = `✅ Task "${createdItem.title}" has been created!`;
        } else if (pendingAction.type === 'schedule_meeting') {
          createdItem = await createMeeting(pendingAction.data, userId);
          responseMessage = `✅ Meeting "${createdItem.title}" has been scheduled!`;
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
      // User declined
      conversation.pendingAction = null;
      await conversation.save();
      return {
        success: true,
        response: "Okay, I won't create that. Is there anything else I can help with?",
        action: 'action_cancelled'
      };
    }
  }
  
  // Handle missing information
  if (pendingAction.missingFields && pendingAction.missingFields.length > 0) {
    const updatedData = { ...pendingAction.data };
    const extractedFields = {};
    let allFieldsFilled = true;
    
    // Extract information from user's message
    for (const field of pendingAction.missingFields) {
      const value = extractField(field, message);
      if (value) {
        updatedData[field] = value;
        extractedFields[field] = value;
      } else {
        allFieldsFilled = false;
      }
    }
    
    if (allFieldsFilled) {
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
      // Still missing some fields, ask for them
      const remainingFields = pendingAction.missingFields.filter(
        f => !updatedData[f]
      );
      
      conversation.pendingAction.missingFields = remainingFields;
      await conversation.save();
      
      return {
        success: true,
        response: getMissingFieldsMessage(remainingFields, extractedFields),
        action: 'needs_info',
        data: { 
          missingFields: remainingFields,
          extractedFields
        }
      };
    }
  }
  
  return null;
}

// Helper function to check if user response is affirmative
function isAffirmative(message) {
  return /^(yes|yeah|yep|sure|ok|okay|confirm|yup|y|go ahead|do it|create|schedule)$/i.test(message);
}

// Helper function to check if user response is negative
function isNegative(message) {
  return /^(no|nope|nah|cancel|stop|don't|do not|never mind|forget it)$/i.test(message);
}

// Helper function to extract field values from user message
function extractField(field, message) {
  switch (field) {
    case 'title':
      return extractTitle(message);
    case 'time':
      return extractTime(message);
    case 'date':
      return extractDate(message);
    case 'duration':
      return extractDuration(message);
    default:
      return null;
  }
}

// Helper functions for extracting specific fields
function extractTitle(message) {
  const titleMatch = /(?:title|name|call(?:ed|ing)|titled?|about|for|regarding|on)[\s:]+["']?([^"'.!?]+)["']?/i.exec(message) || 
                    /(?:create|add|new|schedule|set up)\s+(?:a\s+)?(?:meeting|task|appointment|reminder|event)[\s:]+["']?([^"'.!?]+)["']?/i.exec(message);
  return titleMatch ? (titleMatch[1] || titleMatch[2] || '').trim() : null;
}

function extractTime(message) {
  const timeMatch = /(?:at|by|for|on)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/i.exec(message);
  return timeMatch ? timeMatch[1] : null;
}

function extractDate(message) {
  const dateMatch = /(?:on|for|due|scheduled for)?\s*(?:the\s*)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i.exec(message);
  return dateMatch ? dateMatch[1] : null;
}

function extractDuration(message) {
  const durationMatch = /(?:for|duration|length|time)[\s:]+(\d+)\s*(?:min|minutes?|h|hours?|hrs?)/i.exec(message);
  return durationMatch ? parseInt(durationMatch[1]) : null;
}

// Helper function to prepare action confirmation
async function prepareActionConfirmation(type, data, userId) {
  if (type === 'create_task') {
    // Use Gemini to suggest a schedule if not provided
    if (!data.scheduleType || !data.scheduleTime) {
      try {
        const schedule = await suggestFullScheduleWithGemini({
          userId,
          now: new Date(),
          item: {
            type: 'Task',
            title: data.title || 'Untitled Task',
            description: data.description || ''
          }
        });
        data.scheduleType = schedule.scheduleType;
        data.scheduleTime = schedule.scheduleTime;
        data.startDateISO = schedule.startDateISO;
      } catch (error) {
        console.error('Error suggesting schedule:', error);
        // Fallback to default values
        data.scheduleType = 'one-day';
        data.scheduleTime = { minutesBeforeStart: 15, fixedTime: null };
      }
    }
    
    const timeInfo = data.scheduleTime?.fixedTime 
      ? ` at ${data.scheduleTime.fixedTime}` 
      : data.scheduleTime?.minutesBeforeStart 
        ? ` with ${data.scheduleTime.minutesBeforeStart} minutes reminder`
        : '';
        
    const dateInfo = data.startDateISO 
      ? ` on ${new Date(data.startDateISO).toLocaleDateString()}` 
      : '';
      
    return {
      confirmationMessage: `I'll create a task \"${data.title}\"${timeInfo}${dateInfo}. Is that correct?`,
      data
    };
    
  } else if (type === 'schedule_meeting') {
    // Format meeting time
    let timeInfo = '';
    if (data.time) {
      timeInfo = ` at ${data.time}`;
    }
    
    // Format meeting date
    let dateInfo = '';
    if (data.date) {
      dateInfo = ` on ${data.date}`;
    } else if (data.startTime) {
      dateInfo = ` on ${new Date(data.startTime).toLocaleDateString()}`;
    }
    
    // Format duration
    let durationInfo = '';
    if (data.duration) {
      durationInfo = ` for ${data.duration} minutes`;
    }
    
    // Format recurrence
    let recurrenceInfo = '';
    if (data.isRecurring) {
      recurrenceInfo = data.recurrencePattern 
        ? ` (recurring ${data.recurrencePattern})`
        : ' (recurring)';
    }
    
    return {
      confirmationMessage: `I'll schedule a meeting \"${data.title}\"${timeInfo}${dateInfo}${durationInfo}${recurrenceInfo}. Is that correct?`,
      data
    };
  }
  
  return { confirmationMessage: 'Should I proceed with this?', data };
}

// Helper function to create a task in the database
async function createTask(taskData, userId) {
  const task = new Task({
    title: taskData.title,
    description: taskData.description || '',
    user: userId,
    dueDate: taskData.startDateISO ? new Date(taskData.startDateISO) : null,
    isCompleted: false,
    priority: taskData.priority || 'medium',
    scheduleType: taskData.scheduleType || 'one-day',
    scheduleTime: taskData.scheduleTime || { minutesBeforeStart: 15, fixedTime: null },
    isRoutine: taskData.isRoutine || false
  });
  
  return await task.save();
}

// Helper function to create a meeting in the database
async function createMeeting(meetingData, userId) {
  // Calculate end time based on duration (default 30 minutes)
  const duration = meetingData.duration || 30;
  const startTime = meetingData.startTime ? new Date(meetingData.startTime) : new Date();
  const endTime = new Date(startTime.getTime() + duration * 60000);
  
  const meeting = new Meeting({
    title: meetingData.title,
    description: meetingData.description || '',
    user: userId,
    startTime: startTime,
    endTime: endTime,
    isRecurring: meetingData.isRecurring || false,
    recurrencePattern: meetingData.recurrencePattern || null,
    location: meetingData.location || '',
    attendees: meetingData.attendees || []
  });
  
  return await meeting.save();
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