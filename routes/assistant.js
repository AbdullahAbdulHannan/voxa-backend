const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const auth = require('../middleware/authMiddleware');
const Conversation = require('../models/Conversation');
const { v4: uuidv4 } = require('uuid');

// Initialize Google's Generative AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// System prompt for the AI assistant
const SYSTEM_PROMPT = `You are Bela, a helpful AI assistant for the VoxaAI productivity app. 
Your main functions are:
1. Answer general questions helpfully and concisely
2. Help users create tasks and meetings
3. Provide productivity tips and suggestions

When creating tasks or meetings, you should:
- Ask for any missing information (title, time, date, etc.)
- Confirm details before creating
- Be friendly and professional in all responses

Format task/meeting details as JSON when applicable.`;

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
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message }
        ]
      });
    } else {
      conversation.messages.push({ role: 'user', content: message });
    }

    // Get model and start chat
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const chat = model.startChat({
      history: conversation.messages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      }))
    });

    // Send message to Gemini
    const result = await chat.sendMessage(message);
    const response = await result.response;
    const text = response.text();

    // Save assistant's response to conversation
    conversation.messages.push({ role: 'assistant', content: text });
    await conversation.save();

    // Check for task/meeting creation intent
    const action = detectAction(text, message);
    
    res.json({
      success: true,
      response: text,
      action: action ? action.type : null,
      data: action ? action.data : null
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
function detectAction(assistantResponse, userMessage) {
  const lowerResponse = assistantResponse.toLowerCase();
  const lowerMessage = userMessage.toLowerCase();
  
  // Check for task creation intent
  if (lowerResponse.includes('create a task') || 
      lowerMessage.includes('create a task') ||
      lowerMessage.includes('add a task') ||
      lowerMessage.includes('new task')) {
    
    // Extract task details using regex or other NLP techniques
    const titleMatch = /(?:title|name|call(?:ed|ing)|titled?)[\s:]+["']?([^"'.!?]+)["']?/i.exec(userMessage);
    const timeMatch = /(?:at|by|for|on)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(userMessage);
    const dateMatch = /(?:on|for)?\s*(?:the\s*)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i.exec(userMessage);
    
    const taskType = lowerMessage.includes('routine') || lowerMessage.includes('daily') || lowerMessage.includes('weekly') 
      ? 'routine' 
      : 'one-day';
    
    return {
      type: 'create_task',
      data: {
        title: titleMatch ? titleMatch[1].trim() : null,
        type: taskType,
        time: timeMatch ? timeMatch[1] : null,
        date: dateMatch ? dateMatch[1] : null
      }
    };
  }
  
  // Check for meeting creation intent
  if (lowerResponse.includes('create a meeting') || 
      lowerMessage.includes('schedule a meeting') ||
      lowerMessage.includes('set up a meeting') ||
      lowerMessage.includes('new meeting')) {
    
    // Extract meeting details using regex or other NLP techniques
    const titleMatch = /(?:meeting|call|appointment)(?:\s+(?:about|for|regarding|on))?[\s:]+["']?([^"'.!?]+)["']?/i.exec(userMessage);
    const timeMatch = /(?:at|by|for|on)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(userMessage);
    const dateMatch = /(?:on|for)?\s*(?:the\s*)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i.exec(userMessage);
    
    return {
      type: 'create_meeting',
      data: {
        title: titleMatch ? titleMatch[1].trim() : null,
        time: timeMatch ? timeMatch[1] : null,
        date: dateMatch ? dateMatch[1] : null
      }
    };
  }
  
  return null;
}

module.exports = router;
