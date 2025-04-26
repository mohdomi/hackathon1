const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const { DateTime } = require('luxon');

const PORT = 8000;

// Configuration
const DATA_FILE = "cargo_data.json";
const LOG_FILE = "cargo_logs.json";

// Middleware
app.use(express.json());

/**
 * Load cargo data from file
 * @returns {Object} The cargo data
 */
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  }
  return {
    "items": {},
    "containers": {},
    "waste_containers": {}
  };
}

/**
 * Save cargo data to file
 * @param {Object} data - The data to save
 */
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * Log astronaut actions
 * @param {string} action - The action to log
 * @param {Object} details - The details of the action
 * @returns {Object} The log entry
 */
function logAction(action, details) {
  const logEntry = {
    "timestamp": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss"),
    "action": action,
    "details": details
  };
  
  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  }
  
  logs.push(logEntry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  
  return logEntry;
}

// Feature 1: Efficient Placement of Items
app.post('/api/place_item', (req, res) => {
  const data = loadData();
  const itemData = req.body;
  
  if (!itemData || !itemData.item_id) {
    return res.status(400).json({"error": "Invalid item data"});
  }
  
  // Assign a new ID if not provided
  const itemId = itemData.item_id || `item_${Date.now()}`;
  
  // Check if container is specified
  const specifiedContainer = itemData.container_id;
  
  if (specifiedContainer) {
    // Check if container exists and has space
    if (!data.containers[specifiedContainer]) {
      return res.status(404).json({"error": `Container ${specifiedContainer} not found`});
    }
    
    const container = data.containers[specifiedContainer];
    
    // Check space availability
    if (container.used_volume + itemData.volume > container.total_volume) {
      return res.status(400).json({"error": `Not enough space in container ${specifiedContainer}`});
    }
    
    if (container.current_weight + itemData.weight > container.max_weight) {
      return res.status(400).json({"error": `Weight limit exceeded in container ${specifiedContainer}`});
    }
    
    // Place the item
    data.items[itemId] = {
      "name": itemData.name,
      "location": specifiedContainer,
      "priority": itemData.priority || 3,  // Default priority is 3 (medium)
      "expiration_date": itemData.expiration_date,
      "volume": itemData.volume,
      "weight": itemData.weight,
      "category": itemData.category || 'general',
      "status": "active",
      "arrival_date": DateTime.now().toFormat("yyyy-MM-dd"),
      "last_accessed": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss")
    };
    
    // Update container
    data.containers[specifiedContainer].used_volume += itemData.volume;
    data.containers[specifiedContainer].current_weight += itemData.weight;
    data.containers[specifiedContainer].items.push(itemId);
    
  } else {
    // Find the best container using algorithm
    const bestContainer = findBestContainerForItem(data, itemData);
    
    if (!bestContainer) {
      // If no suitable container found, suggest rearrangement
      const rearrangementPlan = suggestRearrangement(data, itemData);
      if (rearrangementPlan && rearrangementPlan.length > 0) {
        return res.status(200).json({
          "status": "rearrangement_needed",
          "message": "Rearrangement needed to accommodate this item",
          "rearrangement_plan": rearrangementPlan
        });
      } else {
        return res.status(400).json({"error": "No space available for this item, and rearrangement not possible"});
      }
    }
    
    // Place the item in the best container
    data.items[itemId] = {
      "name": itemData.name,
      "location": bestContainer,
      "priority": itemData.priority || 3,
      "expiration_date": itemData.expiration_date,
      "volume": itemData.volume,
      "weight": itemData.weight,
      "category": itemData.category || 'general',
      "status": "active",
      "arrival_date": DateTime.now().toFormat("yyyy-MM-dd"),
      "last_accessed": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss")
    };
    
    // Update container
    data.containers[bestContainer].used_volume += itemData.volume;
    data.containers[bestContainer].current_weight += itemData.weight;
    data.containers[bestContainer].items.push(itemId);
  }
  
  saveData(data);
  
  // Log the action
  logAction("place_item", {
    "item_id": itemId,
    "container_id": specifiedContainer || bestContainer,
    "timestamp": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss")
  });
  
  return res.status(201).json({
    "status": "success",
    "message": `Item ${itemId} placed in container ${specifiedContainer || bestContainer}`,
    "item_id": itemId,
    "container_id": specifiedContainer || bestContainer
  });
});

/**
 * Algorithm to find the best container for a new item
 * @param {Object} data - The cargo data
 * @param {Object} itemData - The item data
 * @returns {string|null} The best container ID or null if none found
 */
function findBestContainerForItem(data, itemData) {
  const itemVolume = itemData.volume;
  const itemWeight = itemData.weight;
  const itemPriority = itemData.priority || 3;
  
  // Create a score for each container
  const containerScores = [];
  
  for (const [containerId, container] of Object.entries(data.containers)) {
    // Skip waste and return containers
    if (container.type !== 'storage') {
      continue;
    }
    
    // Skip containers that don't have enough space or weight capacity
    if (container.used_volume + itemVolume > container.total_volume) {
      continue;
    }
    
    if (container.current_weight + itemWeight > container.max_weight) {
      continue;
    }
    
    // Calculate score based on:
    // 1. Space efficiency (how well the item fits)
    // 2. Accessibility factor
    // 3. Priority alignment (match high priority items with accessible containers)
    
    // Space efficiency: containers with just enough space get higher scores
    const remainingSpace = container.total_volume - container.used_volume;
    const spaceEfficiency = 1 - (remainingSpace - itemVolume) / container.total_volume;
    
    // Accessibility is important for high priority items
    // High priority (5) items should go in more accessible containers
    const accessibilityScore = container.accessibility_factor * (itemPriority / 5);
    
    // Combine scores (adjust weights as needed)
    const totalScore = (spaceEfficiency * 0.5) + (accessibilityScore * 0.5);
    
    containerScores.push({score: totalScore, containerId});
  }
  
  // Sort by score in descending order
  containerScores.sort((a, b) => b.score - a.score);
  
  // Return the best container or null if no suitable container
  return containerScores.length > 0 ? containerScores[0].containerId : null;
}

// Feature 2: Quick Retrieval of Items
app.get('/api/find_item', (req, res) => {
  const data = loadData();
  const searchQuery = (req.query.query || '').toLowerCase();
  const category = req.query.category;
  
  // Find matching items
  const matchingItems = [];
  
  for (const [itemId, item] of Object.entries(data.items)) {
    if (item.status !== 'active') {
      continue;
    }
    
    if ((item.name.toLowerCase().includes(searchQuery) || itemId.toLowerCase().includes(searchQuery)) && 
        (!category || item.category === category)) {
      // Get container info for accessibility calculation
      const container = data.containers[item.location];
      
      // Calculate retrieval score based on:
      // 1. Accessibility of container
      // 2. Position in container (approximated by when it was added)
      // 3. Priority of item
      // 4. Expiration date (items closer to expiry get priority)
      
      // Basic retrieval time based on accessibility
      let retrievalTime = (1 - container.accessibility_factor) * 10;  // 0-10 minutes
      
      // Adjust for position in container (more recent items are easier to access)
      const itemIndex = container.items.indexOf(itemId);
      const positionFactor = itemIndex / Math.max(1, container.items.length);
      retrievalTime += positionFactor * 5;  // Add 0-5 minutes based on position
      
      // Store item with its retrieval information
      const itemInfo = {
        "item_id": itemId,
        "name": item.name,
        "location": item.location,
        "container_name": container.name,
        "priority": item.priority,
        "category": item.category,
        "estimated_retrieval_time_minutes": Math.round(retrievalTime * 100) / 100,
        "expiration_date": item.expiration_date
      };
      
      matchingItems.push(itemInfo);
    }
  }
  
  // Sort items by retrieval time (fastest first)
  matchingItems.sort((a, b) => a.estimated_retrieval_time_minutes - b.estimated_retrieval_time_minutes);
  
  // Check for expiring items
  const currentDate = DateTime.now().toJSDate();
  for (const item of matchingItems) {
    if (item.expiration_date) {
      const expDate = DateTime.fromFormat(item.expiration_date, "yyyy-MM-dd").toJSDate();
      const daysToExpiry = Math.floor((expDate - currentDate) / (1000 * 60 * 60 * 24));
      item.days_to_expiry = daysToExpiry;
      
      // Flag items expiring soon
      if (daysToExpiry <= 7) {
        item.expiring_soon = true;
      }
    }
  }
  
  // Log the search action
  logAction("search_item", {
    "query": searchQuery,
    "category": category,
    "results_count": matchingItems.length,
    "timestamp": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss")
  });
  
  return res.status(200).json({
    "status": "success",
    "items": matchingItems,
    "count": matchingItems.length
  });
});

app.post('/api/retrieve_item/:itemId', (req, res) => {
  const data = loadData();
  const itemId = req.params.itemId;
  
  if (!data.items[itemId]) {
    return res.status(404).json({"error": `Item ${itemId} not found`});
  }
  
  const item = data.items[itemId];
  const containerId = item.location;
  
  // Update last accessed time
  data.items[itemId].last_accessed = DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
  
  // Log retrieval
  logAction("retrieve_item", {
    "item_id": itemId,
    "item_name": item.name,
    "container_id": containerId,
    "timestamp": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss")
  });
  
  saveData(data);
  
  return res.status(200).json({
    "status": "success",
    "message": `Item ${itemId} retrieved`,
    "item": data.items[itemId]
  });
});

// Feature 3: Rearrangement Optimization
function suggestRearrangement(data, newItem) {
  const itemVolume = newItem.volume;
  const itemWeight = newItem.weight;
  
  // Check each container for potential rearrangements
  const potentialMoves = [];
  
  // Try to find space by moving items between containers
  for (const [containerId, container] of Object.entries(data.containers)) {
    if (container.type !== 'storage') {
      continue;
    }
    
    // If this container could fit the new item with some rearrangement
    if (container.total_volume - container.used_volume + itemVolume <= container.total_volume &&
        container.max_weight - container.current_weight + itemWeight <= container.max_weight) {
      
      // Look for items that could be moved elsewhere
      for (const itemId of container.items) {
        const item = data.items[itemId];
        
        // Check other containers that could hold this item
        for (const [otherContainerId, otherContainer] of Object.entries(data.containers)) {
          if (otherContainerId === containerId || otherContainer.type !== 'storage') {
            continue;
          }
          
          // Check if the other container has space
          if (otherContainer.used_volume + item.volume <= otherContainer.total_volume &&
              otherContainer.current_weight + item.weight <= otherContainer.max_weight) {
            
            // This is a potential move
            potentialMoves.push({
              "item_id": itemId,
              "item_name": item.name,
              "from_container": containerId,
              "to_container": otherContainerId,
              "volume_freed": item.volume,
              "weight_freed": item.weight
            });
          }
        }
      }
    }
  }
  
  // Sort potential moves by volume freed (most efficient first)
  potentialMoves.sort((a, b) => b.volume_freed - a.volume_freed);
  
  // Create a rearrangement plan
  const rearrangementPlan = [];
  let freedVolume = 0;
  let freedWeight = 0;
  
  for (const move of potentialMoves) {
    if (freedVolume >= itemVolume && freedWeight >= itemWeight) {
      break;
    }
    
    rearrangementPlan.push(move);
    freedVolume += move.volume_freed;
    freedWeight += move.weight_freed;
  }
  
  return rearrangementPlan;
}

app.post('/api/rearrange_items', (req, res) => {
  const data = loadData();
  const plan = req.body.rearrangement_plan || [];
  
  if (plan.length === 0) {
    return res.status(400).json({"error": "No rearrangement plan provided"});
  }
  
  // Execute each move in the plan
  for (const move of plan) {
    const itemId = move.item_id;
    const fromContainer = move.from_container;
    const toContainer = move.to_container;
    
    if (!data.items[itemId] || 
        !data.containers[fromContainer] || 
        !data.containers[toContainer]) {
      return res.status(400).json({"error": `Invalid move: ${JSON.stringify(move)}`});
    }
    
    const item = data.items[itemId];
    
    // Update containers
    data.containers[fromContainer].used_volume -= item.volume;
    data.containers[fromContainer].current_weight -= item.weight;
    data.containers[fromContainer].items = data.containers[fromContainer].items.filter(id => id !== itemId);
    
    data.containers[toContainer].used_volume += item.volume;
    data.containers[toContainer].current_weight += item.weight;
    data.containers[toContainer].items.push(itemId);
    
    // Update item location
    data.items[itemId].location = toContainer;
    data.items[itemId].last_accessed = DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
  }
  
  saveData(data);
  
  // Log the rearrangement
  logAction("rearrange_items", {
    "plan": plan,
    "timestamp": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss")
  });
  
  return res.status(200).json({
    "status": "success",
    "message": "Rearrangement completed successfully",
    "moves_completed": plan.length
  });
});

// Feature 4: Waste Disposal Management
app.post('/api/mark_as_waste', (req, res) => {
  const data = loadData();
  const requestData = req.body;
  
  if (!requestData || !requestData.item_id) {
    return res.status(400).json({"error": "Item ID is required"});
  }
  
  const itemId = requestData.item_id;
  const reason = requestData.reason || 'used';  // 'used', 'expired', 'damaged', etc.
  
  if (!data.items[itemId]) {
    return res.status(404).json({"error": `Item ${itemId} not found`});
  }
  
  const item = data.items[itemId];
  const oldContainerId = item.location;
  
  // Update item status
  data.items[itemId].status = 'waste';
  
  // Find appropriate waste container
  const wasteContainer = findWasteContainer(data, item);
  
  if (!wasteContainer) {
    return res.status(400).json({
      "status": "error",
      "message": "No suitable waste container found. Create a new waste container."
    });
  }
  
  // Move item from current container to waste container
  // Update old container
  data.containers[oldContainerId].used_volume -= item.volume;
  data.containers[oldContainerId].current_weight -= item.weight;
  data.containers[oldContainerId].items = data.containers[oldContainerId].items.filter(id => id !== itemId);
  
  // Update waste container
  data.waste_containers[wasteContainer].used_volume += item.volume;
  data.waste_containers[wasteContainer].current_weight += item.weight;
  
  // Update item location to indicate waste container
  data.items[itemId].location = `waste_${wasteContainer}`;
  
  saveData(data);
  
  // Log waste disposal
  logAction("mark_as_waste", {
    "item_id": itemId,
    "item_name": item.name,
    "reason": reason,
    "waste_container": wasteContainer,
    "timestamp": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss")
  });
  
  return res.status(200).json({
    "status": "success",
    "message": `Item ${itemId} marked as waste and assigned to waste container ${wasteContainer}`,
    "waste_container": wasteContainer
  });
});

function findWasteContainer(data, item) {
  const itemCategory = item.category;
  const itemVolume = item.volume;
  const itemWeight = item.weight;
  
  // Find suitable waste container
  const suitableContainers = [];
  
  for (const [containerId, container] of Object.entries(data.waste_containers)) {
    // Check if container accepts this waste category
    if (container.waste_categories && 
        !container.waste_categories.includes(itemCategory) && 
        !container.waste_categories.includes('general')) {
      continue;
    }
    
    // Check if container has enough space and weight capacity
    if (container.used_volume + itemVolume <= container.total_volume &&
        container.current_weight + itemWeight <= container.max_weight) {
      
      // Calculate efficiency score (how well this item fits the container)
      const remainingSpace = container.total_volume - container.used_volume;
      const spaceEfficiency = 1 - (remainingSpace - itemVolume) / container.total_volume;
      
      suitableContainers.push({efficiency: spaceEfficiency, containerId});
    }
  }
  
  // Return the most efficient container
  suitableContainers.sort((a, b) => b.efficiency - a.efficiency);
  return suitableContainers.length > 0 ? suitableContainers[0].containerId : null;
}

// Feature 5: Cargo Return Planning
app.get('/api/return_planning/:wasteContainerId', (req, res) => {
  const data = loadData();
  const wasteContainerId = req.params.wasteContainerId;
  
  if (!data.waste_containers[wasteContainerId]) {
    return res.status(404).json({"error": `Waste container ${wasteContainerId} not found`});
  }
  
  const container = data.waste_containers[wasteContainerId];
  
  // Get all waste items in this container
  const wasteItems = [];
  let totalVolume = 0;
  let totalWeight = 0;
  
  for (const [itemId, item] of Object.entries(data.items)) {
    if (item.location === `waste_${wasteContainerId}`) {
      wasteItems.push({
        "item_id": itemId,
        "name": item.name,
        "category": item.category,
        "volume": item.volume,
        "weight": item.weight,
        "status": item.status
      });
      
      totalVolume += item.volume;
      totalWeight += item.weight;
    }
  }
  
  // Generate return plan
  const returnPlan = {
    "container_id": wasteContainerId,
    "container_name": container.name,
    "undock_date": container.undock_date || 'Not scheduled',
    "waste_items": wasteItems,
    "total_items": wasteItems.length,
    "total_volume": totalVolume,
    "total_weight": totalWeight,
    "volume_utilization": (totalVolume / container.total_volume) * 100 || 0,
    "weight_utilization": (totalWeight / container.max_weight) * 100 || 0,
    "space_reclamation": {
      "volume_reclaimed": totalVolume,
      "weight_reclaimed": totalWeight
    }
  };
  
  // Log the planning activity
  logAction("return_planning", {
    "waste_container_id": wasteContainerId,
    "total_items": wasteItems.length,
    "total_volume": totalVolume,
    "total_weight": totalWeight,
    "timestamp": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss")
  });
  
  return res.status(200).json({
    "status": "success",
    "return_plan": returnPlan
  });
});

app.post('/api/confirm_return/:wasteContainerId', (req, res) => {
  const data = loadData();
  const wasteContainerId = req.params.wasteContainerId;
  
  if (!data.waste_containers[wasteContainerId]) {
    return res.status(404).json({"error": `Waste container ${wasteContainerId} not found`});
  }
  
  // Get all waste items in this container
  const itemsToRemove = [];
  
  for (const [itemId, item] of Object.entries(data.items)) {
    if (item.location === `waste_${wasteContainerId}`) {
      itemsToRemove.push(itemId);
    }
  }
  
  // Remove items and container
  for (const itemId of itemsToRemove) {
    delete data.items[itemId];
  }
  
  // Store container info before deleting for the log
  const containerInfo = data.waste_containers[wasteContainerId];
  
  // Remove the waste container
  delete data.waste_containers[wasteContainerId];
  
  saveData(data);
  
  // Log the return confirmation
  logAction("confirm_return", {
    "waste_container_id": wasteContainerId,
    "container_name": containerInfo.name,
    "items_removed": itemsToRemove.length,
    "timestamp": DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss")
  });
  
  return res.status(200).json({
    "status": "success",
    "message": `Waste container ${wasteContainerId} confirmed returned`,
    "items_removed": itemsToRemove.length
  });
});

// Feature 6: Logging (already implemented throughout)
app.get('/api/logs', (req, res) => {
    // Optional filters
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;
    const actionType = req.query.action_type;
    const limit = parseInt(req.query.limit || 100);
    
    // Load logs
    let logs = [];
    if (fs.existsSync(LOG_FILE)) {
      logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    }
    
    // Apply filters
    let filteredLogs = logs;
    
    if (startDate) {
      const start = new Date(startDate);
      filteredLogs = filteredLogs.filter(log => 
        new Date(log.timestamp) >= start);
    }
    
    if (endDate) {
      const end = new Date(endDate);
      filteredLogs = filteredLogs.filter(log => 
        new Date(log.timestamp) <= end);
    }
    
    if (actionType) {
      filteredLogs = filteredLogs.filter(log => log.action === actionType);
    }
    
    // Limit results and sort by most recent first
    filteredLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const limitedLogs = filteredLogs.slice(0, limit);
    
    return res.json({
      status: "success",
      total_logs: filteredLogs.length,
      logs: limitedLogs
    });
  });
  
  // Additional API Endpoints for Container Management
  app.post('/api/add_container', (req, res) => {
    const data = loadData();
    const containerData = req.body;
    
    if (!containerData || !containerData.container_id) {
      return res.status(400).json({ error: "Invalid container data" });
    }
    
    const containerId = containerData.container_id;
    
    if (containerId in data.containers) {
      return res.status(400).json({ error: `Container ID ${containerId} already exists` });
    }
    
    // Add new container
    data.containers[containerId] = {
      name: containerData.name,
      total_volume: parseFloat(containerData.total_volume),
      used_volume: 0.0,
      max_weight: parseFloat(containerData.max_weight),
      current_weight: 0.0,
      items: [],
      type: containerData.type || 'storage',
      accessibility_factor: parseFloat(containerData.accessibility_factor || 0.5)
    };
    
    saveData(data);
    
    // Log the action
    logAction("add_container", {
      container_id: containerId,
      container_name: containerData.name,
      type: containerData.type || 'storage',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19)
    });
    
    return res.status(201).json({
      status: "success",
      message: `Container ${containerId} added successfully`,
      container: data.containers[containerId]
    });
  });
  
  app.post('/api/add_waste_container', (req, res) => {
    const data = loadData();
    const containerData = req.body;
    
    if (!containerData || !containerData.container_id) {
      return res.status(400).json({ error: "Invalid container data" });
    }
    
    const containerId = containerData.container_id;
    
    if (containerId in data.waste_containers) {
      return res.status(400).json({ error: `Waste container ID ${containerId} already exists` });
    }
    
    // Add new waste container
    data.waste_containers[containerId] = {
      name: containerData.name,
      total_volume: parseFloat(containerData.total_volume),
      used_volume: 0.0,
      max_weight: parseFloat(containerData.max_weight),
      current_weight: 0.0,
      waste_categories: containerData.waste_categories || ['general'],
      undock_date: containerData.undock_date
    };
    
    saveData(data);
    
    // Log the action
    logAction("add_waste_container", {
      container_id: containerId,
      container_name: containerData.name,
      waste_categories: containerData.waste_categories || ['general'],
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19)
    });
    
    return res.status(201).json({
      status: "success",
      message: `Waste container ${containerId} added successfully`,
      container: data.waste_containers[containerId]
    });
  });
  
  app.get('/api/get_storage_status', (req, res) => {
    const data = loadData();
    
    // Calculate overall statistics
    let totalStorageVolume = 0;
    let usedStorageVolume = 0;
    let totalStorageWeightCapacity = 0;
    let currentStorageWeight = 0;
    
    let totalWasteVolume = 0;
    let usedWasteVolume = 0;
    let totalWasteWeightCapacity = 0;
    let currentWasteWeight = 0;
    
    // Items statistics
    let totalActiveItems = 0;
    let totalWasteItems = 0;
    let itemsByCategory = {};
    let itemsExpiringSoon = 0;
    
    // Get today's date for expiration calculation
    const today = new Date();
    
    // Calculate container statistics
    const storageContainers = [];
    Object.entries(data.containers).forEach(([containerId, container]) => {
      totalStorageVolume += container.total_volume;
      usedStorageVolume += container.used_volume;
      totalStorageWeightCapacity += container.max_weight;
      currentStorageWeight += container.current_weight;
      
      // Calculate utilization percentages
      const volumeUtilization = container.total_volume > 0 ? 
        (container.used_volume / container.total_volume) * 100 : 0;
      const weightUtilization = container.max_weight > 0 ? 
        (container.current_weight / container.max_weight) * 100 : 0;
      
      storageContainers.push({
        container_id: containerId,
        name: container.name,
        type: container.type,
        volume_utilization: Number(volumeUtilization.toFixed(2)),
        weight_utilization: Number(weightUtilization.toFixed(2)),
        item_count: container.items.length,
        accessibility_factor: container.accessibility_factor
      });
    });
    
    // Calculate waste container statistics
    const wasteContainers = [];
    Object.entries(data.waste_containers).forEach(([containerId, container]) => {
      totalWasteVolume += container.total_volume;
      usedWasteVolume += container.used_volume;
      totalWasteWeightCapacity += container.max_weight;
      currentWasteWeight += container.current_weight;
      
      // Calculate utilization percentages
      const volumeUtilization = container.total_volume > 0 ? 
        (container.used_volume / container.total_volume) * 100 : 0;
      const weightUtilization = container.max_weight > 0 ? 
        (container.current_weight / container.max_weight) * 100 : 0;
      
      wasteContainers.push({
        container_id: containerId,
        name: container.name,
        volume_utilization: Number(volumeUtilization.toFixed(2)),
        weight_utilization: Number(weightUtilization.toFixed(2)),
        waste_categories: container.waste_categories || ['general'],
        undock_date: container.undock_date
      });
    });
    
    // Calculate item statistics
    Object.entries(data.items).forEach(([itemId, item]) => {
      if (item.status === 'active') {
        totalActiveItems += 1;
        
        // Count by category
        const category = item.category || 'general';
        if (!itemsByCategory[category]) {
          itemsByCategory[category] = 0;
        }
        itemsByCategory[category] += 1;
        
        // Check for expiring items
        if (item.expiration_date) {
          const expDate = new Date(item.expiration_date);
          const daysToExpiry = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
          if (daysToExpiry <= 7 && daysToExpiry >= 0) {
            itemsExpiringSoon += 1;
          }
        }
      } else if (item.status === 'waste') {
        totalWasteItems += 1;
      }
    });
    
    // Generate summary statistics
    const storageStats = {
      total_volume: totalStorageVolume,
      used_volume: usedStorageVolume,
      volume_utilization: totalStorageVolume > 0 ? 
        Number(((usedStorageVolume / totalStorageVolume) * 100).toFixed(2)) : 0,
      total_weight_capacity: totalStorageWeightCapacity,
      current_weight: currentStorageWeight,
      weight_utilization: totalStorageWeightCapacity > 0 ? 
        Number(((currentStorageWeight / totalStorageWeightCapacity) * 100).toFixed(2)) : 0,
      container_count: Object.keys(data.containers).length
    };
    
    const wasteStats = {
      total_volume: totalWasteVolume,
      used_volume: usedWasteVolume,
      volume_utilization: totalWasteVolume > 0 ? 
        Number(((usedWasteVolume / totalWasteVolume) * 100).toFixed(2)) : 0,
      total_weight_capacity: totalWasteWeightCapacity,
      current_weight: currentWasteWeight,
      weight_utilization: totalWasteWeightCapacity > 0 ? 
        Number(((currentWasteWeight / totalWasteWeightCapacity) * 100).toFixed(2)) : 0,
      container_count: Object.keys(data.waste_containers).length
    };
    
    const itemStats = {
      total_active_items: totalActiveItems,
      total_waste_items: totalWasteItems,
      items_by_category: itemsByCategory,
      items_expiring_soon: itemsExpiringSoon
    };
    
    return res.json({
      status: "success",
      storage_stats: storageStats,
      waste_stats: wasteStats,
      item_stats: itemStats,
      storage_containers: storageContainers,
      waste_containers: wasteContainers
    });
  });
  
  app.get('/api/expiring_items', (req, res) => {
    const data = loadData();
    const days = parseInt(req.query.days || 7);  // Default to 7 days
    
    const today = new Date();
    const expiringItems = [];
    
    Object.entries(data.items).forEach(([itemId, item]) => {
      if (item.status !== 'active' || !item.expiration_date) {
        return;
      }
      
      const expDate = new Date(item.expiration_date);
      const daysToExpiry = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
      
      if (daysToExpiry >= 0 && daysToExpiry <= days) {
        const container = data.containers[item.location];
        
        expiringItems.push({
          item_id: itemId,
          name: item.name,
          days_to_expiry: daysToExpiry,
          expiration_date: item.expiration_date,
          location: item.location,
          container_name: container.name,
          priority: item.priority,
          category: item.category
        });
      }
    });
    
    // Sort by days to expiry (ascending)
    expiringItems.sort((a, b) => a.days_to_expiry - b.days_to_expiry);
    
    return res.json({
      status: "success",
      expiring_items: expiringItems,
      count: expiringItems.length
    });
  });
  
  app.get('/api/item/:itemId', (req, res) => {
    const data = loadData();
    const itemId = req.params.itemId;
    
    if (!(itemId in data.items)) {
      return res.status(404).json({ error: `Item ${itemId} not found` });
    }
    
    const item = data.items[itemId];
    
    // Get container information
    let containerInfo = null;
    if (item.status === 'active') {
      if (item.location in data.containers) {
        const container = data.containers[item.location];
        containerInfo = {
          container_id: item.location,
          name: container.name,
          type: container.type,
          accessibility_factor: container.accessibility_factor
        };
      }
    } else if (item.status === 'waste') {
      // Extract waste container ID from the location (format: "waste_container_id")
      const wasteContainerId = item.location.replace("waste_", "");
      if (wasteContainerId in data.waste_containers) {
        const container = data.waste_containers[wasteContainerId];
        containerInfo = {
          container_id: wasteContainerId,
          name: container.name,
          type: "waste",
          undock_date: container.undock_date
        };
      }
    }
    
    // If the item has an expiration date, calculate days until expiry
    let daysToExpiry = null;
    if (item.expiration_date) {
      const expDate = new Date(item.expiration_date);
      const today = new Date();
      daysToExpiry = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
    }
    
    // Compile item details
    const itemDetails = {
      item_id: itemId,
      name: item.name,
      status: item.status,
      location: item.location,
      container: containerInfo,
      priority: item.priority,
      category: item.category,
      volume: item.volume,
      weight: item.weight,
      arrival_date: item.arrival_date,
      last_accessed: item.last_accessed,
      expiration_date: item.expiration_date,
      days_to_expiry: daysToExpiry
    };
    
    // Log the view action
    logAction("view_item", {
      item_id: itemId,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19)
    });
    
    return res.json({
      status: "success",
      item: itemDetails
    });
  });
  
  app.put('/api/update_item/:itemId', (req, res) => {
    const data = loadData();
    const itemId = req.params.itemId;
    const updateData = req.body;
    
    if (!(itemId in data.items)) {
      return res.status(404).json({ error: `Item ${itemId} not found` });
    }
    
    const item = data.items[itemId];
    const oldData = { ...item };  // For logging
    
    // Check if container is being changed
    const newContainer = updateData.location;
    const oldContainer = item.location;
    
    if (newContainer && newContainer !== oldContainer && item.status === 'active') {
      // Ensure new container exists
      if (!(newContainer in data.containers)) {
        return res.status(404).json({ error: `Container ${newContainer} not found` });
      }
      
      // Check if new container has enough space
      const container = data.containers[newContainer];
      if (container.used_volume + item.volume > container.total_volume) {
        return res.status(400).json({ error: `Not enough space in container ${newContainer}` });
      }
      
      if (container.current_weight + item.weight > container.max_weight) {
        return res.status(400).json({ error: `Weight limit exceeded in container ${newContainer}` });
      }
      
      // Update old container
      data.containers[oldContainer].used_volume -= item.volume;
      data.containers[oldContainer].current_weight -= item.weight;
      data.containers[oldContainer].items = data.containers[oldContainer].items.filter(id => id !== itemId);
      
      // Update new container
      data.containers[newContainer].used_volume += item.volume;
      data.containers[newContainer].current_weight += item.weight;
      data.containers[newContainer].items.push(itemId);
    }
    
    // Update allowed fields
    ['name', 'priority', 'expiration_date', 'category'].forEach(field => {
      if (field in updateData) {
        data.items[itemId][field] = updateData[field];
      }
    });
    
    // Always update last_accessed time
    data.items[itemId].last_accessed = new Date().toISOString().replace('T', ' ').slice(0, 19);
    
    saveData(data);
    
    // Log the update
    logAction("update_item", {
      item_id: itemId,
      old_data: oldData,
      new_data: data.items[itemId],
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19)
    });
    
    return res.json({
      status: "success",
      message: `Item ${itemId} updated successfully`,
      item: data.items[itemId]
    });
  });
  
  // Feature 7: Efficiency Monitoring
  app.get('/api/efficiency_metrics', (req, res) => {
    const data = loadData();
    
    // Load logs for time-based analysis
    let logs = [];
    if (fs.existsSync(LOG_FILE)) {
      logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    }
    
    // Calculate space utilization efficiency
    const totalStorageVolume = Object.values(data.containers).reduce((sum, container) => 
      sum + container.total_volume, 0);
    const usedStorageVolume = Object.values(data.containers).reduce((sum, container) => 
      sum + container.used_volume, 0);
    
    const spaceUtilization = totalStorageVolume > 0 ? 
      (usedStorageVolume / totalStorageVolume * 100) : 0;
    
    // Calculate retrieval efficiency (average time between searches and retrievals)
    const retrievalTimes = [];
    const searchTimestamps = {};
    
    logs.forEach(log => {
      if (log.action === 'search_item') {
        if (log.details.results) {
          log.details.results.forEach(result => {
            searchTimestamps[result] = new Date(log.timestamp);
          });
        }
      } else if (log.action === 'retrieve_item') {
        const itemId = log.details.item_id;
        if (searchTimestamps[itemId]) {
          const searchTime = searchTimestamps[itemId];
          const retrievalTime = new Date(log.timestamp);
          const timeDiff = (retrievalTime - searchTime) / 1000; // in seconds
          retrievalTimes.push(timeDiff);
        }
      }
    });
    
    const avgRetrievalTime = retrievalTimes.length > 0 ? 
      retrievalTimes.reduce((sum, time) => sum + time, 0) / retrievalTimes.length : 0;
    
    // Calculate waste management efficiency
    let wasteUtilization = 0;
    if (Object.keys(data.waste_containers).length > 0) {
      const totalWasteVolume = Object.values(data.waste_containers).reduce((sum, container) => 
        sum + container.total_volume, 0);
      const usedWasteVolume = Object.values(data.waste_containers).reduce((sum, container) => 
        sum + container.used_volume, 0);
      wasteUtilization = totalWasteVolume > 0 ? 
        (usedWasteVolume / totalWasteVolume * 100) : 0;
    }
    
    // Calculate rearrangement efficiency
    const rearrangementLogs = logs.filter(log => log.action === 'rearrange_items');
    const avgMovesPerRearrangement = rearrangementLogs.length > 0 ? 
      rearrangementLogs.reduce((sum, log) => sum + log.details.plan.length, 0) / rearrangementLogs.length : 0;
    
    // Calculate expiration management efficiency
    const today = new Date();
    let expiredItems = 0;
    
    Object.values(data.items).forEach(item => {
      if (item.expiration_date) {
        const expDate = new Date(item.expiration_date);
        if (expDate < today && item.status === 'active') {
          expiredItems += 1;
        }
      }
    });
    
    const totalItems = Object.values(data.items).filter(item => item.status === 'active').length;
    const expirationEfficiency = totalItems > 0 ? 
      100 - (expiredItems / totalItems * 100) : 100;
    
    // Compile efficiency metrics
    const efficiencyMetrics = {
      space_utilization: Number(spaceUtilization.toFixed(2)),
      average_retrieval_time_seconds: Number(avgRetrievalTime.toFixed(2)),
      waste_management_efficiency: Number(wasteUtilization.toFixed(2)),
      rearrangement_efficiency: {
        avg_moves_per_rearrangement: Number(avgMovesPerRearrangement.toFixed(2)),
        total_rearrangements: rearrangementLogs.length
      },
      expiration_management: {
        efficiency_percentage: Number(expirationEfficiency.toFixed(2)),
        expired_items: expiredItems,
        total_items: totalItems
      }
    };
    
    return res.json({
      status: "success",
      efficiency_metrics: efficiencyMetrics
    });
  });
  
  // Create an undock plan for a module
  app.post('/api/undock_plan', (req, res) => {
    const data = loadData();
    const planData = req.body;
    
    if (!planData || !planData.module_id) {
      return res.status(400).json({ error: "Module ID is required" });
    }
    
    const moduleId = planData.module_id;
    const undockDate = planData.undock_date || 
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // 7 days from now
    const planType = planData.type || 'waste';  // 'waste' or 'return'
    
    // If it's a waste container, mark the undock date
    if (planType === 'waste' && moduleId in data.waste_containers) {
      data.waste_containers[moduleId].undock_date = undockDate;
      
      // Get all waste items in this container
      const wasteItems = [];
      Object.entries(data.items).forEach(([itemId, item]) => {
        if (item.location === `waste_${moduleId}`) {
          wasteItems.push(itemId);
        }
      });
      
      saveData(data);
      
      // Log the undock plan
      logAction("create_undock_plan", {
        module_id: moduleId,
        undock_date: undockDate,
        type: planType,
        items_count: wasteItems.length,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19)
      });
      
      return res.status(201).json({
        status: "success",
        message: `Undock plan created for waste container ${moduleId}`,
        undock_date: undockDate,
        items_count: wasteItems.length
      });
    } else {
      return res.status(404).json({ error: `Module ${moduleId} not found or type mismatch` });
    }
  });
  
  // Initialize DB with some sample data if it doesn't exist
  function initializeSampleData() {
    if (!fs.existsSync(DATA_FILE)) {
      const now = new Date();
      
      const sampleData = {
        items: {
          "item_001": {
            name: "Food Packet A",
            location: "storage_001",
            priority: 4,
            expiration_date: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            volume: 0.5,
            weight: 0.3,
            category: "food",
            status: "active",
            arrival_date: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            last_accessed: now.toISOString().replace('T', ' ').slice(0, 19)
          },
          "item_002": {
            name: "Medical Kit",
            location: "storage_002",
            priority: 5,
            expiration_date: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            volume: 2.0,
            weight: 1.5,
            category: "medical",
            status: "active",
            arrival_date: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            last_accessed: now.toISOString().replace('T', ' ').slice(0, 19)
          }
        },
        containers: {
          "storage_001": {
            name: "Main Storage A",
            total_volume: 100.0,
            used_volume: 0.5,
            max_weight: 200.0,
            current_weight: 0.3,
            items: ["item_001"],
            type: "storage",
            accessibility_factor: 0.9
          },
          "storage_002": {
            name: "Medical Storage",
            total_volume: 50.0,
            used_volume: 2.0,
            max_weight: 100.0,
            current_weight: 1.5,
            items: ["item_002"],
            type: "storage",
            accessibility_factor: 0.8
          }
        },
        waste_containers: {
          "waste_001": {
            name: "General Waste",
            total_volume: 30.0,
            used_volume: 0.0,
            max_weight: 50.0,
            current_weight: 0.0,
            waste_categories: ["general", "organic"],
            undock_date: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          }
        }
      };
      
      fs.writeFileSync(DATA_FILE, JSON.stringify(sampleData, null, 2));
    }
  }
  
  // Start the server
  if (require.main === module) {
    // Initialize sample data if needed
    initializeSampleData();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  }