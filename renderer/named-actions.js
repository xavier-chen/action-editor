"use strict";

(function exposeNamedActionController(root) {
  const actionModel = root.FaceActionLibrary;
  const motorRegistry = root.FaceMotorRegistry;
  if (!actionModel) throw new Error("动作编辑器缺少命名动作模型");
  if (!motorRegistry) throw new Error("动作编辑器缺少电机注册表");

  const ACTION_TIMELINE_FILE_FORMAT = "lummotor-action-timeline-project";
  const ACTION_TIMELINE_FILE_SCHEMA_VERSION = 1;
  const DEFAULT_DURATION_MS = 10_000;
  const DEFAULT_SNAP_MS = 100;
  const DEFAULT_PIXELS_PER_SECOND = 120;
  const DEFAULT_NAMED_MOTION_SNAP_MS = 100;
  const NAMED_MOTION_PIXELS_PER_SECOND = 110;
  const MIN_NAMED_MOTION_DURATION_MS = 7_000;
  const MIN_NAMED_MOTION_CLIP_WIDTH_PX = 72;
  const NAMED_MOTION_CLIP_HEIGHT_PX = 38;
  const NAMED_MOTION_CLIP_LAYER_STEP_PX = 42;
  const NAMED_MOTION_CLIP_GAP_PX = 4;
  const MAX_EXPANDED_MOTIONS = 4_096;
  const SNAP_OPTIONS = new Set([0, 50, 100, 250, 500, 1_000]);
  const byId = (id) => document.getElementById(id);

  let library = new actionModel.ActionLibrary();
  let sequence = new actionModel.NamedActionTimeline();
  let actionTracks = new actionModel.ActionTrackCatalog();
  let selectedDefinitionId = null;
  let selectedTimelineDefinitionId = null;
  let selectedTrackId = null;
  let selectedPlacementId = null;
  let draftDefinitionId = null;
  let draftName = "";
  let draftMotions = [];
  let selectedDraftMotionIndex = null;
  let motionDirection = 1;
  let namedMotionCursorMs = 0;
  let namedMotionSnapMs = DEFAULT_NAMED_MOTION_SNAP_MS;
  let namedMotionCursorDrag = null;
  let namedMotionClipDrag = null;
  let durationMs = DEFAULT_DURATION_MS;
  let snapMs = DEFAULT_SNAP_MS;
  let pixelsPerSecond = DEFAULT_PIXELS_PER_SECOND;
  let cursorMs = 0;
  let actionSearchQuery = "";
  let paletteDragDefinitionId = null;
  let paletteDragTrackId = null;
  let cursorDrag = null;
  let placementDrag = null;
  let profileRefreshHandle = null;
  let definitionDurationCache = new WeakMap();
  let initialized = false;

  function interactionLocked() {
    return state.busy || state.configIoBusy || state.connecting || state.disconnecting;
  }

  function actionTimelineFileStableId(value, label) {
    if (
      typeof value !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
      || new TextEncoder().encode(value).length > 128
    ) {
      throw new TypeError(`${label}必须是 1–128 字节的安全稳定 ID`);
    }
    return value;
  }

  function normalizedMotionForEstimate(motion) {
    return {
      motorId: motion.motorId,
      nodeId: motion.nodeId,
      startMs: motion.startMs,
      signedSteps: motion.signedSteps,
      speed: motion.speed,
      acceleration: motion.acceleration,
      closed: motion.closed,
    };
  }

  function motionEstimate(motion) {
    return timelineActionEstimate(normalizedMotionForEstimate(motion));
  }

  function motionSchedule(motions) {
    const availableByNode = new Map();
    return motions
      .map((motion, index) => ({ motion, index }))
      .sort((left, right) => (
        left.motion.startMs - right.motion.startMs || left.index - right.index
      ))
      .map(({ motion, index }) => {
        const estimate = motionEstimate(motion);
        const estimatedStartMs = Math.max(
          motion.startMs,
          availableByNode.get(motion.nodeId) || 0,
        );
        const estimatedEndMs = estimatedStartMs + estimate.durationMs;
        availableByNode.set(motion.nodeId, estimatedEndMs);
        return Object.freeze({
          motion,
          index,
          estimate,
          estimatedStartMs,
          estimatedEndMs,
          queuedDelayMs: estimatedStartMs - motion.startMs,
        });
      });
  }

  function definitionDuration(definitionOrMotions) {
    const cacheableDefinition = !Array.isArray(definitionOrMotions)
      && definitionOrMotions
      && typeof definitionOrMotions === "object"
      ? definitionOrMotions
      : null;
    if (cacheableDefinition && definitionDurationCache.has(cacheableDefinition)) {
      return definitionDurationCache.get(cacheableDefinition);
    }
    const motions = Array.isArray(definitionOrMotions)
      ? definitionOrMotions
      : cacheableDefinition?.motions || [];
    const latestEndMs = motionSchedule(motions).reduce(
      (latest, entry) => Math.max(latest, entry.estimatedEndMs),
      0,
    );
    if (cacheableDefinition) definitionDurationCache.set(cacheableDefinition, latestEndMs);
    return latestEndMs;
  }

  function namedMotionTimelineDurationMs() {
    const latestStartMs = draftMotions.reduce(
      (latest, motion) => Math.max(latest, motion.startMs),
      0,
    );
    const contentEndMs = Math.max(
      namedMotionCursorMs,
      latestStartMs,
      definitionDuration(draftMotions),
      state.timelineRun?.surface === "namedAction" ? state.timelineRun.durationMs : 0,
    );
    return Math.min(
      actionModel.MAX_START_MS,
      Math.max(MIN_NAMED_MOTION_DURATION_MS, Math.ceil(contentEndMs / 1_000) * 1_000),
    );
  }

  function namedMotionConflictIndexes() {
    const buckets = new Map();
    draftMotions.forEach((motion, index) => {
      const key = `${motion.startMs}:${motion.nodeId}`;
      const bucket = buckets.get(key) || [];
      bucket.push(index);
      buckets.set(key, bucket);
    });
    return new Set([...buckets.values()]
      .filter((bucket) => bucket.length > 1)
      .flat());
  }

  function namedMotionClipGeometry(motion, scheduled) {
    const estimate = scheduled?.estimate || motionEstimate(motion);
    const visibleDurationMs = Math.max(
      1,
      Math.min(estimate.durationMs, actionModel.MAX_START_MS - motion.startMs),
    );
    return {
      estimate,
      leftPx: motion.startMs / 1_000 * NAMED_MOTION_PIXELS_PER_SECOND,
      widthPx: Math.max(
        MIN_NAMED_MOTION_CLIP_WIDTH_PX,
        visibleDurationMs / 1_000 * NAMED_MOTION_PIXELS_PER_SECOND,
      ),
    };
  }

  function packNamedMotionLane(entries, scheduleByIndex) {
    const occupiedUntilByLayer = [];
    return entries.map(({ index }) => {
      const motion = draftMotions[index];
      const scheduled = scheduleByIndex.get(index);
      const geometry = namedMotionClipGeometry(motion, scheduled);
      let layer = occupiedUntilByLayer.findIndex((occupiedUntil) => (
        geometry.leftPx >= occupiedUntil + NAMED_MOTION_CLIP_GAP_PX
      ));
      if (layer < 0) layer = occupiedUntilByLayer.length;
      occupiedUntilByLayer[layer] = geometry.leftPx + geometry.widthPx;
      return { index, motion, scheduled, layer, ...geometry };
    });
  }

  function maximumPlacementStartMs(definitionOrMotions) {
    const motions = Array.isArray(definitionOrMotions)
      ? definitionOrMotions
      : definitionOrMotions?.motions || [];
    const latestRelativeStartMs = motions.reduce(
      (latest, motion) => Math.max(latest, motion.startMs),
      0,
    );
    return Math.max(0, actionModel.MAX_START_MS - latestRelativeStartMs);
  }

  function definitionById(actionDefinitionId) {
    if (typeof actionDefinitionId !== "string" || !actionDefinitionId) return null;
    return library.get(actionDefinitionId);
  }

  function actionTrackById(trackId) {
    if (typeof trackId !== "string" || !trackId) return null;
    return actionTracks.get(trackId);
  }

  function nextDefaultTrackName() {
    const names = new Set(actionTracks.snapshot().map(({ name }) => name));
    for (let number = 1; number <= actionModel.MAX_ACTION_TRACKS + 1; number += 1) {
      const candidate = `轨道 ${number}`;
      if (!names.has(candidate)) return candidate;
    }
    return `轨道 ${actionTracks.size + 1}`;
  }

  function ensureDefaultActionTrack() {
    if (!actionTracks.size) actionTracks.add({ name: "轨道 1" });
    if (!actionTrackById(selectedTrackId)) {
      selectedTrackId = actionTracks.snapshot()[0]?.trackId || null;
    }
    return actionTrackById(selectedTrackId);
  }

  function ensureDurationCoversSequence() {
    const latestEndMs = latestSequenceEndMs();
    const requiredDurationMs = Math.min(
      actionModel.MAX_START_MS,
      Math.ceil(latestEndMs / 1_000) * 1_000,
    );
    durationMs = Math.max(durationMs, requiredDurationMs);
    cursorMs = Math.min(cursorMs, durationMs);
    return latestEndMs;
  }

  function motionBindingCurrent(motion) {
    return hasMotor(motion.motorId) && bindingNodeId(motion.motorId) === motion.nodeId;
  }

  function definitionBindingCurrent(definition) {
    return Boolean(definition) && definition.motions.every(motionBindingCurrent);
  }

  function cloneMotions(motions) {
    return motions.map((motion) => ({ ...motion }));
  }

  function resetNamedMotionTimeline() {
    namedMotionCursorMs = 0;
    namedMotionCursorDrag = null;
    namedMotionClipDrag = null;
  }

  function resetMotionEditor() {
    selectedDraftMotionIndex = null;
    motionDirection = 1;
    byId("namedMotionStartInput").value = String(namedMotionCursorMs);
    byId("namedMotionStepsInput").value = "1000";
    byId("namedMotionSpeedInput").value = "20";
    byId("namedMotionAccelerationInput").value = "20";
    byId("namedMotionLoopModeSelect").value = "open";
    renderMotionDirection();
    renderMotionBindingHint();
  }

  async function confirmDiscardDraft() {
    if (!draftIsDirty()) return true;
    return confirmAction(
      "放弃未保存的动作修改",
      "当前动作还有未保存的名称或电机运动修改。继续切换会丢弃这些修改。",
      "放弃并继续",
    );
  }

  async function startNewDefinition(options = {}) {
    if (interactionLocked()) return;
    if (!options.force && !await confirmDiscardDraft()) return;
    if (interactionLocked()) return;
    selectedDefinitionId = null;
    draftDefinitionId = null;
    draftName = "";
    draftMotions = [];
    resetNamedMotionTimeline();
    byId("namedActionNameInput").value = "";
    resetMotionEditor();
    renderAll();
    byId("namedActionNameInput").focus();
  }

  async function loadDefinition(actionDefinitionId) {
    if (interactionLocked()) return;
    const definition = definitionById(actionDefinitionId);
    if (!definition) return;
    if (definition.actionDefinitionId === draftDefinitionId && !draftIsDirty()) return;
    if (!await confirmDiscardDraft()) return;
    if (interactionLocked()) return;
    const currentDefinition = definitionById(actionDefinitionId);
    if (!currentDefinition) return;
    selectedDefinitionId = currentDefinition.actionDefinitionId;
    draftDefinitionId = currentDefinition.actionDefinitionId;
    draftName = currentDefinition.name;
    draftMotions = cloneMotions(currentDefinition.motions);
    resetNamedMotionTimeline();
    selectedDraftMotionIndex = null;
    byId("namedActionNameInput").value = draftName;
    resetMotionEditor();
    renderAll();
  }

  function draftIsDirty() {
    const saved = definitionById(draftDefinitionId);
    if (!saved) return Boolean(draftName.trim() || draftMotions.length);
    return draftName !== saved.name
      || JSON.stringify(draftMotions) !== JSON.stringify(saved.motions);
  }

  function populateMotorSelect() {
    const select = byId("namedMotionMotorSelect");
    const previous = select.value;
    select.replaceChildren();
    for (const group of state.groups) {
      const motors = state.motors.filter((motor) => motor.group === group.id);
      if (!motors.length) continue;
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const motor of motors) {
        const option = document.createElement("option");
        option.value = motor.id;
        const nodeId = bindingNodeId(motor.id);
        option.textContent = nodeId == null ? `${motor.label} · ID 未配置` : `${motor.label} · ID ${nodeId}`;
        optgroup.append(option);
      }
      select.append(optgroup);
    }
    const options = [...select.options];
    const preferred = options.find(({ value }) => value === previous)
      || options.find(({ value }) => bindingNodeId(value) != null)
      || options[0];
    if (preferred) select.value = preferred.value;
  }

  function renderMotionDirection() {
    for (const button of document.querySelectorAll(".named-motion-direction-button")) {
      const active = Number(button.dataset.direction) === motionDirection;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function setMotionDirection(direction) {
    if (direction !== 1 && direction !== -1) return;
    motionDirection = direction;
    renderMotionDirection();
  }

  function renderMotionBindingHint() {
    const hint = byId("namedMotionBindingHint");
    const motorId = byId("namedMotionMotorSelect").value;
    const motor = motorById(motorId);
    const nodeId = bindingNodeId(motorId);
    hint.className = "named-motion-binding-hint";
    if (!motor) {
      hint.textContent = "当前没有可用电机";
      return;
    }
    if (nodeId == null) {
      hint.classList.add("stale");
      hint.textContent = `${motor.label} 尚未配置 CAN ID`;
      return;
    }
    hint.classList.add("ready");
    hint.textContent = `${motor.label} · 当前节点 ID ${nodeId}`;
    if (state.connected) void ensureMotionProfile(nodeId);
  }

  function motionDraftFromForm() {
    const motorId = byId("namedMotionMotorSelect").value;
    const nodeId = bindingNodeId(motorId);
    return actionModel.validateMotion({
      motorId,
      nodeId,
      startMs: byId("namedMotionStartInput").value,
      signedSteps: motionDirection * positiveStepMagnitude(byId("namedMotionStepsInput").value),
      speed: byId("namedMotionSpeedInput").value,
      acceleration: byId("namedMotionAccelerationInput").value,
      closed: byId("namedMotionLoopModeSelect").value === "closed",
    });
  }

  function addDraftMotion() {
    try {
      if (draftMotions.length >= actionModel.MAX_MOTIONS_PER_DEFINITION) {
        throw new RangeError(`每个动作最多 ${actionModel.MAX_MOTIONS_PER_DEFINITION} 个电机运动`);
      }
      const motion = { ...motionDraftFromForm() };
      draftMotions.push(motion);
      namedMotionCursorMs = motion.startMs;
      selectedDraftMotionIndex = null;
      resetMotionEditor();
      renderAll();
      toast("电机运动已添加到动作草稿");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  function populateDraftMotionEditor(index) {
    const motion = draftMotions[index];
    if (!motion) return false;
    selectedDraftMotionIndex = index;
    namedMotionCursorMs = motion.startMs;
    populateMotorSelect();
    byId("namedMotionMotorSelect").value = motion.motorId;
    byId("namedMotionStartInput").value = String(motion.startMs);
    byId("namedMotionStepsInput").value = String(Math.abs(motion.signedSteps));
    byId("namedMotionSpeedInput").value = String(motion.speed);
    byId("namedMotionAccelerationInput").value = String(motion.acceleration);
    byId("namedMotionLoopModeSelect").value = motion.closed ? "closed" : "open";
    setMotionDirection(motion.signedSteps < 0 ? -1 : 1);
    renderMotionBindingHint();
    return true;
  }

  function loadDraftMotion(index) {
    if (interactionLocked() || !populateDraftMotionEditor(index)) return;
    renderAll();
  }

  function updateDraftMotion() {
    if (!Number.isInteger(selectedDraftMotionIndex) || !draftMotions[selectedDraftMotionIndex]) return;
    try {
      const previous = draftMotions[selectedDraftMotionIndex];
      const updated = {
        ...(previous.motionId ? { motionId: previous.motionId } : {}),
        ...motionDraftFromForm(),
      };
      draftMotions[selectedDraftMotionIndex] = updated;
      namedMotionCursorMs = updated.startMs;
      selectedDraftMotionIndex = null;
      resetMotionEditor();
      renderAll();
      toast("动作中的电机运动已更新");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  function removeDraftMotion(index) {
    if (!draftMotions[index] || interactionLocked()) return;
    draftMotions.splice(index, 1);
    if (selectedDraftMotionIndex === index) resetMotionEditor();
    else if (Number.isInteger(selectedDraftMotionIndex) && selectedDraftMotionIndex > index) {
      selectedDraftMotionIndex -= 1;
    }
    renderAll();
  }

  function saveDefinition() {
    if (interactionLocked()) return;
    try {
      const staleMotion = draftMotions.find((motion) => !motionBindingCurrent(motion));
      if (staleMotion) {
        throw new Error(`${motorById(staleMotion.motorId)?.label || staleMotion.motorId} 保存的 ID ${staleMotion.nodeId} 已失效，请先更新该电机运动`);
      }
      const conflicts = expandedConflicts(expandedPlanFromMotions(draftMotions));
      if (conflicts.length) {
        const [{ startMs, motion }] = conflicts[0];
        throw new Error(`${startMs} ms 的节点 ID ${motion.nodeId} 有多个电机运动，请错开时间后再保存`);
      }
      const creating = !draftDefinitionId;
      const current = definitionById(draftDefinitionId);
      const placementCount = current
        ? sequence.snapshot().filter(({ actionDefinitionId }) => (
          actionDefinitionId === current.actionDefinitionId
        )).length
        : 0;
      const projectedExpandedCount = expandedSequence().length
        + placementCount * (draftMotions.length - (current?.motions.length || 0));
      if (projectedExpandedCount > MAX_EXPANDED_MOTIONS) {
        throw new RangeError(`动作时间轴展开后最多允许 ${MAX_EXPANDED_MOTIONS} 个电机运动，请先减少该动作的实例或运动片段`);
      }
      const maximumStartMs = maximumPlacementStartMs(draftMotions);
      const overflowPlacement = current
        ? sequence.snapshot().find((placement) => (
          placement.actionDefinitionId === current.actionDefinitionId
          && placement.startMs > maximumStartMs
        ))
        : null;
      if (overflowPlacement) {
        throw new RangeError(`该动作已有实例位于 ${overflowPlacement.startMs} ms；按当前运动起点，实例最晚只能放在 ${maximumStartMs} ms，请先在动作时间轴中向前移动`);
      }
      const input = { name: draftName, motions: draftMotions };
      const saved = draftDefinitionId
        ? library.update(draftDefinitionId, input)
        : library.add(input);
      selectedDefinitionId = saved.actionDefinitionId;
      if (creating || !definitionById(selectedTimelineDefinitionId)) {
        selectedTimelineDefinitionId = saved.actionDefinitionId;
      }
      draftDefinitionId = saved.actionDefinitionId;
      draftName = saved.name;
      draftMotions = cloneMotions(saved.motions);
      byId("namedActionNameInput").value = saved.name;
      selectedDraftMotionIndex = null;
      ensureDurationCoversSequence();
      const savedLocally = persistState(true);
      renderAll();
      toast(
        savedLocally ? `动作“${saved.name}”已保存` : `动作“${saved.name}”已更新，但本机保存失败`,
        savedLocally ? "info" : "error",
      );
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function deleteDefinition() {
    const definition = definitionById(draftDefinitionId);
    if (!definition || interactionLocked()) return;
    const placements = sequence.snapshot().filter(({ actionDefinitionId }) => (
      actionDefinitionId === definition.actionDefinitionId
    ));
    if (placements.length) {
      const confirmed = await confirmAction(
        `删除动作 ${definition.name}`,
        `该动作已在动作时间轴中放置 ${placements.length} 次。删除动作时会同时删除这些时间轴实例。`,
        "删除动作",
      );
      if (!confirmed || interactionLocked() || !definitionById(definition.actionDefinitionId)) return;
    }
    for (const placement of placements) sequence.remove(placement.placementId);
    library.remove(definition.actionDefinitionId);
    if (selectedTimelineDefinitionId === definition.actionDefinitionId) {
      selectedTimelineDefinitionId = library.snapshot()[0]?.actionDefinitionId || null;
    }
    if (selectedPlacementId && !sequence.get(selectedPlacementId)) selectedPlacementId = null;
    await startNewDefinition({ force: true });
    const savedLocally = persistState(true);
    renderAll();
    toast(
      savedLocally ? `动作“${definition.name}”已删除` : `动作已删除，但本机保存失败`,
      savedLocally ? "info" : "error",
    );
  }

  function renderDefinitionList() {
    const rootElement = byId("namedActionDefinitionList");
    rootElement.replaceChildren();
    const definitions = library.snapshot();
    for (const definition of definitions) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `named-action-definition-item${definition.actionDefinitionId === selectedDefinitionId ? " selected" : ""}`;
      item.dataset.actionDefinitionId = definition.actionDefinitionId;
      const name = document.createElement("b");
      name.textContent = definition.name;
      const detail = document.createElement("small");
      const laneCount = new Set(definition.motions.map(({ motorId }) => motorId)).size;
      detail.textContent = `${laneCount} 条电机轨 · ${definition.motions.length} 个运动 · ${formatEstimatedDuration(definitionDuration(definition))}`;
      const arrow = document.createElement("span");
      arrow.textContent = "›";
      item.append(name, detail, arrow);
      rootElement.append(item);
    }
    if (!definitions.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "还没有命名动作";
      rootElement.append(empty);
    }
    byId("namedActionDefinitionCount").textContent = String(definitions.length);
  }

  function renderDefinitionForm() {
    if (document.activeElement !== byId("namedActionNameInput")) {
      byId("namedActionNameInput").value = draftName;
    }
    const dirty = draftIsDirty();
    const status = byId("namedActionDraftStatus");
    status.className = dirty ? "dirty" : "";
    status.textContent = draftDefinitionId
      ? (dirty ? "当前修改尚未保存" : "已保存，可继续添加或修改运动")
      : (draftMotions.length ? "新动作尚未保存" : "输入名称并添加至少一个电机运动");
    byId("namedActionSaveButton").textContent = draftDefinitionId ? "保存当前动作" : "保存为命名动作";
    byId("namedActionDeleteButton").disabled = interactionLocked() || !draftDefinitionId;
  }

  function renderNamedMotionSummary() {
    byId("namedMotionCount").textContent = String(draftMotions.length);
    byId("namedActionEstimatedDuration").textContent = draftMotions.length
      ? formatEstimatedDuration(definitionDuration(draftMotions))
      : "—";
    byId("namedActionContentTitle").textContent = draftName.trim() || "未命名动作";
  }

  function renderNamedMotionTimelineRuler(visualDurationMs) {
    const ruler = byId("namedMotionTimelineRuler");
    ruler.replaceChildren();
    const seconds = Math.ceil(visualDurationMs / 1_000);
    const tickStepSeconds = seconds <= 20 ? 1 : seconds <= 60 ? 5 : seconds <= 180 ? 10 : 30;
    for (let second = 0; second <= seconds; second += tickStepSeconds) {
      const tick = document.createElement("span");
      tick.className = "named-motion-ruler-tick";
      tick.style.left = `${second * NAMED_MOTION_PIXELS_PER_SECOND}px`;
      const label = document.createElement("span");
      label.textContent = second < 60
        ? `${second}s`
        : `${Math.floor(second / 60)}:${String(second % 60).padStart(2, "0")}`;
      tick.append(label);
      ruler.append(tick);
    }
  }

  function renderMotionList(schedule = motionSchedule(draftMotions)) {
    const rootElement = byId("namedMotionList");
    rootElement.replaceChildren();
    const scheduleByIndex = new Map(schedule.map((entry) => [entry.index, entry]));
    const conflictIndexes = namedMotionConflictIndexes();
    const lanes = actionModel.deriveMotionLanes(
      draftMotions,
      state.motors.map(({ id }) => id),
    );
    const locked = interactionLocked();

    for (const lane of lanes) {
      const row = document.createElement("div");
      row.className = "named-motion-track-row";
      row.dataset.motorId = lane.motorId;
      const motor = motorById(lane.motorId);
      const currentNodeId = bindingNodeId(lane.motorId);
      const laneIsStale = lane.entries.some(({ index }) => (
        !motionBindingCurrent(draftMotions[index])
      ));
      const packedEntries = packNamedMotionLane(lane.entries, scheduleByIndex);
      const layerCount = Math.max(1, ...packedEntries.map(({ layer }) => layer + 1));
      const laneHeightPx = 8 + layerCount * NAMED_MOTION_CLIP_LAYER_STEP_PX;

      const label = document.createElement("div");
      label.className = `named-motion-track-label${laneIsStale ? " stale" : ""}`;
      label.dataset.motorId = lane.motorId;
      label.style.height = `${laneHeightPx}px`;
      const name = document.createElement("b");
      name.textContent = motor?.label || lane.motorId;
      const meta = document.createElement("small");
      meta.textContent = currentNodeId == null
        ? `ID 未配置 · ${lane.entries.length} 个运动`
        : `ID ${currentNodeId} · ${lane.entries.length} 个运动`;
      label.append(name, meta);

      const laneElement = document.createElement("div");
      laneElement.className = "named-motion-track-lane";
      laneElement.dataset.motorId = lane.motorId;
      laneElement.style.height = `${laneHeightPx}px`;
      for (const { index, motion, scheduled, estimate, leftPx, widthPx, layer } of packedEntries) {
        const stale = !motionBindingCurrent(motion);
        const queued = Number(scheduled?.queuedDelayMs) > 0;
        const conflict = conflictIndexes.has(index);
        const clip = document.createElement("div");
        clip.className = `named-motion-clip ${motion.signedSteps < 0 ? "negative" : "positive"} ${motion.closed ? "closed-loop" : "open-loop"}${selectedDraftMotionIndex === index ? " selected" : ""}${queued ? " queued" : ""}${conflict ? " conflict" : ""}${stale ? " stale" : ""}`;
        clip.dataset.motionIndex = String(index);
        clip.dataset.overlapLayer = String(layer);
        clip.style.left = `${leftPx}px`;
        clip.style.top = `${6 + layer * NAMED_MOTION_CLIP_LAYER_STEP_PX}px`;
        clip.style.width = `${widthPx}px`;
        clip.style.height = `${NAMED_MOTION_CLIP_HEIGHT_PX}px`;
        clip.tabIndex = locked ? -1 : 0;
        clip.setAttribute("role", "button");
        clip.setAttribute("aria-disabled", String(locked));
        const motorName = motor?.label || motion.motorId;
        clip.title = `${motorName} · 发送 ${formatTimelineTime(motion.startMs)} · 理论持续 ${formatEstimatedDuration(estimate.durationMs)} · 预计结束 ${formatTimelineTime(scheduled?.estimatedEndMs ?? motion.startMs + estimate.durationMs)} · ID ${motion.nodeId} · ${formatSigned(motion.signedSteps)} step · V${motion.speed}/A${motion.acceleration} · ${loopModeLabel(motion.closed)}${queued ? ` · 同 ID 排队约 ${formatEstimatedDuration(scheduled.queuedDelayMs)}` : ""}${conflict ? " · 同一物理 ID 在相同时刻存在冲突" : ""}${stale ? " · 当前绑定已变化" : ""}`;
        clip.setAttribute("aria-label", `${clip.title}；单击编辑，左右拖动调整开始时间`);
        const primary = document.createElement("b");
        primary.textContent = `${formatSigned(motion.signedSteps)} · ${motion.startMs}ms`;
        const secondary = document.createElement("small");
        secondary.textContent = `${loopModeLabel(motion.closed)} · ID ${motion.nodeId} · V${motion.speed}/A${motion.acceleration}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "named-motion-remove-button";
        remove.dataset.motionIndex = String(index);
        remove.textContent = "×";
        remove.disabled = locked;
        remove.title = `从动作中删除 ${motorName} 的这个运动`;
        remove.setAttribute("aria-label", remove.title);
        clip.append(primary, secondary, remove);
        laneElement.append(clip);
      }
      row.append(label, laneElement);
      rootElement.append(row);
    }

    if (!lanes.length) {
      const empty = document.createElement("p");
      empty.className = "named-motion-timeline-empty";
      empty.textContent = "请添加一个或多个电机运动；每个动作都会拥有自己的独立时间轴";
      rootElement.append(empty);
    }
    renderNamedMotionSummary();
  }

  function renderNamedMotionTimelineCursor(visualDurationMs = namedMotionTimelineDurationMs()) {
    namedMotionCursorMs = Math.min(
      actionModel.MAX_START_MS,
      Math.max(0, namedMotionCursorMs),
    );
    const canvas = byId("namedMotionTimelineCanvas");
    canvas.style.setProperty(
      "--named-motion-playhead-x",
      `${namedMotionCursorMs / 1_000 * NAMED_MOTION_PIXELS_PER_SECOND}px`,
    );
    byId("namedMotionCursorDisplay").textContent = formatTimelineTime(namedMotionCursorMs);
    const playhead = byId("namedMotionTimelinePlayhead");
    playhead.dataset.time = `${namedMotionCursorMs} ms`;
    const ruler = byId("namedMotionTimelineRuler");
    ruler.setAttribute("aria-valuemax", String(visualDurationMs));
    ruler.setAttribute("aria-valuenow", String(namedMotionCursorMs));
    ruler.setAttribute("aria-valuetext", `${namedMotionCursorMs} ms`);
  }

  function renderNamedMotionTimeline() {
    const visualDurationMs = namedMotionTimelineDurationMs();
    const timelineWidth = Math.max(
      720,
      visualDurationMs / 1_000 * NAMED_MOTION_PIXELS_PER_SECOND,
    );
    const canvas = byId("namedMotionTimelineCanvas");
    canvas.style.setProperty("--named-motion-timeline-width", `${timelineWidth}px`);
    canvas.style.setProperty("--named-motion-second-width", `${NAMED_MOTION_PIXELS_PER_SECOND}px`);
    canvas.style.setProperty("--named-motion-minor-width", `${NAMED_MOTION_PIXELS_PER_SECOND / 10}px`);
    byId("namedMotionSnapSelect").value = String(namedMotionSnapMs);
    renderNamedMotionTimelineRuler(visualDurationMs);
    renderMotionList();
    renderNamedMotionTimelineCursor(visualDurationMs);
  }

  function renderMotionEditor() {
    const locked = interactionLocked();
    const nodeId = bindingNodeId(byId("namedMotionMotorSelect").value);
    for (const id of [
      "namedMotionMotorSelect", "namedMotionStartInput", "namedMotionStepsInput",
      "namedMotionSpeedInput", "namedMotionAccelerationInput", "namedMotionLoopModeSelect",
    ]) byId(id).disabled = locked || !state.motors.length;
    for (const button of document.querySelectorAll(".named-motion-direction-button")) {
      button.disabled = locked || !state.motors.length;
    }
    byId("namedMotionAddButton").disabled = locked || nodeId == null;
    byId("namedMotionUpdateButton").hidden = !Number.isInteger(selectedDraftMotionIndex);
    byId("namedMotionUpdateButton").disabled = locked || nodeId == null;
    byId("namedMotionCancelEditButton").hidden = !Number.isInteger(selectedDraftMotionIndex);
    byId("namedMotionCancelEditButton").disabled = locked;
    byId("namedMotionSnapSelect").disabled = locked;
    byId("namedMotionTimelineRuler").tabIndex = locked ? -1 : 0;
    byId("namedMotionTimelineRuler").setAttribute("aria-disabled", String(locked));
    renderMotionDirection();
    renderMotionBindingHint();
  }

  function renderEditorStatus() {
    const run = state.timelineRun;
    const status = byId("namedActionEditorStatus");
    if (run?.surface === "namedAction") {
      status.textContent = run.phase === "draining"
        ? "全部运动已发送，正在等待相关电机执行完成"
        : `正在测试动作 · ${run.sentCount} / ${run.actionCount} 个电机运动已发送`;
    } else if (draftMotions.some((motion) => !motionBindingCurrent(motion))) {
      status.textContent = "动作中存在旧 ID 或已删除电机，请编辑对应运动后再测试或保存";
    } else if (expandedConflicts(expandedPlanFromMotions(draftMotions)).length) {
      status.textContent = "动作中存在同一物理 ID、同一时间的运动冲突，请错开时间后保存";
    } else if (draftIsDirty()) {
      status.textContent = "当前动作有尚未保存的修改；切换动作前请先保存";
    } else {
      status.textContent = "保存后的命名动作可在“动作时间轴”中重复使用；定义修改会同步到已有实例";
    }
  }

  function renderActionEditor() {
    if (!initialized) return;
    populateMotorSelect();
    renderDefinitionList();
    renderDefinitionForm();
    renderNamedMotionTimeline();
    renderMotionEditor();
    renderEditorStatus();
    renderControls();
  }

  function followNamedMotionCursor() {
    if (state.activePage !== "namedAction") return;
    const scroller = byId("namedMotionTimelineScroller");
    const canvasStyle = getComputedStyle(byId("namedMotionTimelineCanvas"));
    const labelWidth = Number.parseFloat(
      canvasStyle.getPropertyValue("--named-motion-label-width"),
    ) || 0;
    const cursorPixels = namedMotionCursorMs / 1_000 * NAMED_MOTION_PIXELS_PER_SECOND;
    const contentX = labelWidth + cursorPixels;
    const left = scroller.scrollLeft + labelWidth + 24;
    const right = scroller.scrollLeft + scroller.clientWidth - 36;
    if (contentX > right) scroller.scrollLeft = Math.max(0, contentX - scroller.clientWidth + 56);
    else if (contentX < left) scroller.scrollLeft = Math.max(0, cursorPixels - 24);
  }

  function setNamedMotionCursorFromPointer(event, autoScroll = false) {
    const scroller = byId("namedMotionTimelineScroller");
    if (autoScroll) {
      const bounds = scroller.getBoundingClientRect();
      const canvasStyle = getComputedStyle(byId("namedMotionTimelineCanvas"));
      const labelWidth = Number.parseFloat(
        canvasStyle.getPropertyValue("--named-motion-label-width"),
      ) || 0;
      if (event.clientX < bounds.left + labelWidth + 24) {
        scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 18);
      } else if (event.clientX > bounds.right - 28) {
        scroller.scrollLeft += 18;
      }
    }
    const rect = byId("namedMotionTimelineRuler").getBoundingClientRect();
    const milliseconds = timelineModel.millisecondsFromPixels(
      event.clientX - rect.left,
      NAMED_MOTION_PIXELS_PER_SECOND,
    );
    namedMotionCursorMs = timelineModel.snapStartMs(
      milliseconds,
      event.altKey ? 0 : namedMotionSnapMs,
      actionModel.MAX_START_MS,
    );
    byId("namedMotionStartInput").value = String(namedMotionCursorMs);
    renderNamedMotionTimelineCursor();
  }

  function beginNamedMotionCursorDrag(event) {
    if (interactionLocked() || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    const ruler = byId("namedMotionTimelineRuler");
    namedMotionCursorDrag = {
      pointerId: event.pointerId,
      originalCursorMs: namedMotionCursorMs,
    };
    ruler.classList.add("dragging");
    byId("namedMotionTimelinePlayhead").classList.add("dragging");
    try {
      ruler.setPointerCapture(event.pointerId);
    } catch (_) {
      namedMotionCursorDrag = null;
      ruler.classList.remove("dragging");
      byId("namedMotionTimelinePlayhead").classList.remove("dragging");
      return;
    }
    ruler.focus({ preventScroll: true });
    setNamedMotionCursorFromPointer(event);
  }

  function moveNamedMotionCursorDrag(event) {
    if (!namedMotionCursorDrag || namedMotionCursorDrag.pointerId !== event.pointerId) return;
    if (interactionLocked()) return finishNamedMotionCursorDrag(event, true);
    event.preventDefault();
    setNamedMotionCursorFromPointer(event, true);
  }

  function finishNamedMotionCursorDrag(event, canceled = false) {
    if (!namedMotionCursorDrag || namedMotionCursorDrag.pointerId !== event.pointerId) return;
    const drag = namedMotionCursorDrag;
    if (!canceled && !interactionLocked()) setNamedMotionCursorFromPointer(event);
    else {
      namedMotionCursorMs = drag.originalCursorMs;
      byId("namedMotionStartInput").value = String(namedMotionCursorMs);
    }
    namedMotionCursorDrag = null;
    const ruler = byId("namedMotionTimelineRuler");
    ruler.classList.remove("dragging");
    byId("namedMotionTimelinePlayhead").classList.remove("dragging");
    try {
      if (ruler.hasPointerCapture(event.pointerId)) ruler.releasePointerCapture(event.pointerId);
    } catch (_) {
      // Capture may already be gone after a page switch or window blur.
    }
    renderNamedMotionTimeline();
  }

  function moveNamedMotionCursorWithKeyboard(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || interactionLocked()) return;
    event.preventDefault();
    const step = namedMotionSnapMs || 50;
    if (event.key === "Home") namedMotionCursorMs = 0;
    else if (event.key === "End") namedMotionCursorMs = namedMotionTimelineDurationMs();
    else {
      namedMotionCursorMs = Math.min(
        actionModel.MAX_START_MS,
        Math.max(0, namedMotionCursorMs + (event.key === "ArrowLeft" ? -step : step)),
      );
    }
    byId("namedMotionStartInput").value = String(namedMotionCursorMs);
    renderNamedMotionTimeline();
    followNamedMotionCursor();
  }

  function syncNamedMotionCursorFromInput() {
    const startMs = Number(byId("namedMotionStartInput").value);
    if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs > actionModel.MAX_START_MS) return;
    const currentVisualDurationMs = Number(
      byId("namedMotionTimelineRuler").getAttribute("aria-valuemax"),
    ) || MIN_NAMED_MOTION_DURATION_MS;
    namedMotionCursorMs = startMs;
    if (startMs > currentVisualDurationMs) renderNamedMotionTimeline();
    else renderNamedMotionTimelineCursor(currentVisualDurationMs);
    followNamedMotionCursor();
  }

  function beginNamedMotionClipDrag(event) {
    if (event.target.closest(".named-motion-remove-button")) return;
    const clip = event.target.closest(".named-motion-clip");
    if (!clip || interactionLocked() || event.button !== 0 || event.isPrimary === false) return;
    const index = Number(clip.dataset.motionIndex);
    let motion = draftMotions[index];
    if (!motion) return;
    event.preventDefault();
    if (selectedDraftMotionIndex === index) {
      try {
        motion = {
          ...(motion.motionId ? { motionId: motion.motionId } : {}),
          ...motionDraftFromForm(),
        };
        draftMotions[index] = motion;
      } catch (error) {
        toast(`请先修正当前运动参数：${errorMessage(error)}`, "error");
        return;
      }
    } else {
      populateDraftMotionEditor(index);
    }
    for (const candidate of document.querySelectorAll(".named-motion-clip.selected")) {
      candidate.classList.toggle("selected", candidate === clip);
    }
    renderDefinitionForm();
    renderMotionEditor();
    renderEditorStatus();
    renderControls();
    renderNamedMotionTimelineCursor();
    try {
      clip.setPointerCapture(event.pointerId);
    } catch (_) {
      return;
    }
    clip.classList.add("dragging");
    namedMotionClipDrag = {
      pointerId: event.pointerId,
      clip,
      index,
      motion,
      originalStartMs: motion.startMs,
      previewStartMs: motion.startMs,
      startClientX: event.clientX,
      startScrollLeft: byId("namedMotionTimelineScroller").scrollLeft,
    };
  }

  function moveNamedMotionClipDrag(event) {
    if (!namedMotionClipDrag || namedMotionClipDrag.pointerId !== event.pointerId) return;
    if (interactionLocked()) return finishNamedMotionClipDrag(event, true);
    event.preventDefault();
    const scroller = byId("namedMotionTimelineScroller");
    const bounds = scroller.getBoundingClientRect();
    if (event.clientX < bounds.left + 28) scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 18);
    else if (event.clientX > bounds.right - 28) scroller.scrollLeft += 18;
    namedMotionClipDrag.previewStartMs = timelineModel.shiftTimelineStartMs(
      namedMotionClipDrag.originalStartMs,
      event.clientX - namedMotionClipDrag.startClientX,
      scroller.scrollLeft - namedMotionClipDrag.startScrollLeft,
      NAMED_MOTION_PIXELS_PER_SECOND,
      event.altKey ? 0 : namedMotionSnapMs,
      actionModel.MAX_START_MS,
    );
    namedMotionClipDrag.clip.style.left = `${namedMotionClipDrag.previewStartMs / 1_000 * NAMED_MOTION_PIXELS_PER_SECOND}px`;
    namedMotionCursorMs = namedMotionClipDrag.previewStartMs;
    byId("namedMotionStartInput").value = String(namedMotionCursorMs);
    renderNamedMotionTimelineCursor();
  }

  function finishNamedMotionClipDrag(event, canceled = false) {
    if (!namedMotionClipDrag || namedMotionClipDrag.pointerId !== event.pointerId) return;
    const drag = namedMotionClipDrag;
    namedMotionClipDrag = null;
    try {
      if (drag.clip.hasPointerCapture(event.pointerId)) drag.clip.releasePointerCapture(event.pointerId);
    } catch (_) {
      // Capture may already be gone after a page switch or window blur.
    }
    const targetIsCurrent = draftMotions[drag.index] === drag.motion;
    const changed = targetIsCurrent && drag.previewStartMs !== drag.originalStartMs;
    if (!canceled && !interactionLocked() && changed) {
      draftMotions[drag.index] = {
        ...actionModel.validateMotion({
          ...drag.motion,
          startMs: drag.previewStartMs,
        }),
      };
      selectedDraftMotionIndex = drag.index;
      namedMotionCursorMs = drag.previewStartMs;
      populateDraftMotionEditor(drag.index);
    } else {
      namedMotionCursorMs = drag.originalStartMs;
      if (targetIsCurrent) populateDraftMotionEditor(drag.index);
    }
    renderAll();
    if (!canceled && changed) toast("运动开始时间已调整；保存当前动作后生效");
  }

  function handleNamedMotionTimelineClick(event) {
    const remove = event.target.closest(".named-motion-remove-button");
    if (remove) {
      removeDraftMotion(Number(remove.dataset.motionIndex));
      return;
    }
    const clip = event.target.closest(".named-motion-clip");
    if (clip) loadDraftMotion(Number(clip.dataset.motionIndex));
  }

  function handleNamedMotionTimelineKeydown(event) {
    if (event.target.closest(".named-motion-remove-button")) return;
    const clip = event.target.closest(".named-motion-clip");
    if (!clip || interactionLocked()) return;
    const index = Number(clip.dataset.motionIndex);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      loadDraftMotion(index);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeDraftMotion(index);
    }
  }

  function expandedSequence(placements = sequence.snapshot()) {
    const expanded = [];
    for (const placement of placements) {
      const definition = definitionById(placement.actionDefinitionId);
      if (!definition) continue;
      for (const motion of definition.motions) {
        const startMs = placement.startMs + motion.startMs;
        expanded.push({ placement, definition, motion, startMs });
      }
    }
    return expanded.sort((left, right) => left.startMs - right.startMs);
  }

  function expandedConflicts(expanded = expandedSequence()) {
    const buckets = new Map();
    for (const entry of expanded) {
      const key = `${entry.startMs}:${entry.motion.nodeId}`;
      const bucket = buckets.get(key) || [];
      bucket.push(entry);
      buckets.set(key, bucket);
    }
    return [...buckets.values()].filter((bucket) => bucket.length > 1);
  }

  function actionTimelineAnalysis() {
    const placements = sequence.snapshot();
    const expanded = expandedSequence(placements);
    const conflictBuckets = expandedConflicts(expanded);
    const overflowEntries = expanded.filter(({ startMs }) => startMs > actionModel.MAX_START_MS);
    return {
      placements,
      expanded,
      conflictBuckets,
      conflictPlacementIds: new Set(conflictBuckets.flatMap((bucket) => (
        bucket.map(({ placement }) => placement.placementId)
      ))),
      overflowEntries,
      overflowPlacementIds: new Set(overflowEntries.map(({ placement }) => placement.placementId)),
      stalePlacements: placements.filter(placementIsStale),
    };
  }

  function placementIsStale(placement) {
    return !definitionBindingCurrent(definitionById(placement.actionDefinitionId));
  }

  function latestSequenceEndMs() {
    return sequence.snapshot().reduce((latest, placement) => {
      const definition = definitionById(placement.actionDefinitionId);
      return Math.max(latest, placement.startMs + (definition ? definitionDuration(definition) : 1));
    }, 0);
  }

  function latestSequenceSendMs() {
    return sequence.snapshot().reduce((latest, placement) => {
      const definition = definitionById(placement.actionDefinitionId);
      const latestRelativeSendMs = definition?.motions.reduce(
        (definitionLatest, motion) => Math.max(definitionLatest, motion.startMs),
        0,
      ) || 0;
      return Math.max(latest, placement.startMs + latestRelativeSendMs);
    }, 0);
  }

  function renderActionTimelineRuler(visualDurationMs) {
    const ruler = byId("actionTimelineRuler");
    ruler.replaceChildren();
    const seconds = Math.ceil(visualDurationMs / 1_000);
    for (let second = 0; second <= seconds; second += 1) {
      const tick = document.createElement("span");
      tick.className = "action-sequence-ruler-tick";
      tick.style.left = `${second * pixelsPerSecond}px`;
      const label = document.createElement("span");
      label.textContent = second < 60
        ? `${second}s`
        : `${Math.floor(second / 60)}:${String(second % 60).padStart(2, "0")}`;
      tick.append(label);
      ruler.append(tick);
    }
  }

  function renderActionTimelineTracks(analysis = actionTimelineAnalysis()) {
    ensureDefaultActionTrack();
    const rootElement = byId("actionTimelineTracks");
    rootElement.replaceChildren();
    const tracks = actionTracks.snapshot();
    const placementsByTrack = new Map(tracks.map((track) => [
      track.trackId,
      [],
    ]));
    for (const placement of analysis.placements) {
      placementsByTrack.get(placement.trackId)?.push(placement);
    }
    const conflicts = analysis.conflictPlacementIds;
    const overflows = analysis.overflowPlacementIds;
    const locked = interactionLocked();
    for (const track of tracks) {
      const row = document.createElement("div");
      row.className = "action-sequence-track-row";
      row.dataset.trackId = track.trackId;
      const selectedTrack = track.trackId === selectedTrackId;
      const label = document.createElement("div");
      label.className = `action-sequence-track-label${selectedTrack ? " selected" : ""}`;
      label.dataset.trackId = track.trackId;
      const heading = document.createElement("div");
      heading.className = "action-track-heading";
      const name = document.createElement("input");
      name.type = "text";
      name.className = "action-track-name-input";
      name.dataset.trackId = track.trackId;
      name.value = track.name;
      name.maxLength = actionModel.MAX_ACTION_TRACK_NAME_LENGTH;
      name.disabled = locked;
      name.setAttribute("aria-label", `轨道名称：${track.name}`);
      name.title = "可直接修改轨道名称";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "action-track-delete-button";
      remove.dataset.trackId = track.trackId;
      remove.textContent = "×";
      remove.disabled = locked || tracks.length <= 1;
      remove.setAttribute("aria-label", `删除轨道 ${track.name}`);
      remove.title = tracks.length <= 1 ? "至少保留一条轨道" : `删除轨道“${track.name}”`;
      heading.append(name, remove);
      const meta = document.createElement("small");
      meta.textContent = `${placementsByTrack.get(track.trackId).length} 个动作实例`;
      label.append(heading, meta);
      const lane = document.createElement("div");
      lane.className = `action-sequence-track-lane${selectedTrack ? " selected" : ""}`;
      lane.dataset.trackId = track.trackId;
      for (const placement of placementsByTrack.get(track.trackId)) {
        const definition = definitionById(placement.actionDefinitionId);
        if (!definition) continue;
        const clip = document.createElement("button");
        const stale = placementIsStale(placement);
        const overflow = overflows.has(placement.placementId);
        const estimatedDurationMs = Math.max(1, definitionDuration(definition));
        const visibleDurationMs = Math.max(
          1,
          Math.min(estimatedDurationMs, actionModel.MAX_START_MS - placement.startMs),
        );
        clip.type = "button";
        clip.className = `action-sequence-clip${placement.placementId === selectedPlacementId ? " selected" : ""}${stale ? " stale" : ""}${conflicts.has(placement.placementId) ? " conflict" : ""}${overflow ? " overflow" : ""}`;
        clip.dataset.placementId = placement.placementId;
        clip.style.left = `${placement.startMs / 1_000 * pixelsPerSecond}px`;
        clip.style.width = `${Math.max(24, visibleDurationMs / 1_000 * pixelsPerSecond)}px`;
        clip.textContent = definition.name;
        clip.title = `${track.name} · ${definition.name} · ${formatTimelineTime(placement.startMs)} · ${definition.motions.length} 个电机运动 · 理论持续 ${formatEstimatedDuration(estimatedDurationMs)}${stale ? " · 存在旧 ID" : ""}${conflicts.has(placement.placementId) ? " · 与同 ID 同时动作冲突" : ""}${overflow ? " · 内部运动的发送时间超过 10:00" : ""}`;
        lane.append(clip);
      }
      row.append(label, lane);
      rootElement.append(row);
    }
  }

  function renderActionTimelineCursor() {
    cursorMs = Math.min(durationMs, Math.max(0, cursorMs));
    byId("actionTimelineCanvas").style.setProperty(
      "--action-playhead-x",
      `${cursorMs / 1_000 * pixelsPerSecond}px`,
    );
    byId("actionTimelineTimeDisplay").textContent = `${formatTimelineTime(cursorMs)} / ${formatTimelineTime(durationMs)}`;
    byId("actionTimelinePlayhead").dataset.time = `${cursorMs} ms`;
    byId("actionTimelineRuler").setAttribute("aria-valuemax", String(durationMs));
    byId("actionTimelineRuler").setAttribute("aria-valuenow", String(cursorMs));
    byId("actionTimelineRuler").setAttribute("aria-valuetext", `${cursorMs} ms`);
    if (!state.timelineRun) renderSelectedDefinitionControl();
  }

  function actionTimelineStatusText(analysis = actionTimelineAnalysis()) {
    const run = state.timelineRun;
    if (run?.surface === "actionTimeline") {
      return run.phase === "draining"
        ? "动作均已发送，正在等待相关电机 FIFO 清空"
        : `正在按时间播放 · ${run.sentCount} / ${run.actionCount} 个电机运动已触发`;
    }
    if (!library.size) return "请先在“动作编辑”中创建并保存动作";
    if (!sequence.size) return "从左侧动作素材点击＋，或直接拖到时间轴的指定位置";
    if (analysis.stalePlacements.length) return `${analysis.stalePlacements.length} 个动作实例包含旧 ID，需回到动作编辑更新对应电机运动`;
    if (analysis.overflowEntries.length) return `${analysis.overflowPlacementIds.size} 个动作实例的内部运动超过 10:00，请向前拖动红色动作块`;
    if (analysis.conflictBuckets.length) return `${analysis.conflictBuckets.length} 组同一物理 ID 同时运动冲突，需拖动动作错开`;
    const targetDefinition = definitionById(selectedTimelineDefinitionId);
    if (targetDefinition && cursorMs > maximumPlacementStartMs(targetDefinition)) {
      return `当前动作最晚只能从 ${formatTimelineTime(maximumPlacementStartMs(targetDefinition))} 开始，请向前移动光标`;
    }
    return "左侧动作可重复点击＋或拖入指定轨道；动作块可左右调时间、上下换轨";
  }

  function normalizeTimelineDefinitionSelection() {
    const definitions = library.snapshot();
    if (!definitions.some(({ actionDefinitionId }) => (
      actionDefinitionId === selectedTimelineDefinitionId
    ))) {
      selectedTimelineDefinitionId = definitions[0]?.actionDefinitionId || null;
    }
    return definitions;
  }

  function renderSelectedDefinitionControl() {
    const definition = definitionById(selectedTimelineDefinitionId);
    const track = ensureDefaultActionTrack();
    const selected = byId("actionTimelineSelectedDefinition");
    if (definition) {
      selected.textContent = `已选择：${definition.name} · ${track?.name || "轨道"} · 光标 ${formatTimelineTime(cursorMs)}`;
    } else {
      selected.textContent = "尚未选择动作";
    }
    const fits = !definition || cursorMs <= maximumPlacementStartMs(definition);
    const addButton = byId("actionTimelineAddButton");
    addButton.disabled = interactionLocked() || !definition || !fits;
    addButton.setAttribute(
      "aria-label",
      definition ? `将动作 ${definition.name} 添加到 ${track?.name || "所选轨道"}的 ${formatTimelineTime(cursorMs)}` : "添加所选动作",
    );
    addButton.title = fits
      ? `在${track?.name || "所选轨道"}的当前光标位置添加动作`
      : `该动作最晚只能从 ${formatTimelineTime(maximumPlacementStartMs(definition))} 开始`;
  }

  function renderActionPalette(analysis = actionTimelineAnalysis()) {
    const definitions = normalizeTimelineDefinitionSelection();
    const locked = interactionLocked();
    const search = byId("actionTimelineSearchInput");
    if (document.activeElement !== search) search.value = actionSearchQuery;
    search.disabled = locked;
    const placementCountByDefinition = new Map();
    for (const placement of analysis.placements) {
      placementCountByDefinition.set(
        placement.actionDefinitionId,
        (placementCountByDefinition.get(placement.actionDefinitionId) || 0) + 1,
      );
    }
    const needle = actionSearchQuery.trim().normalize("NFC").toLocaleLowerCase("zh-CN");
    const visibleDefinitions = definitions.filter((definition) => (
      !needle || definition.name.normalize("NFC").toLocaleLowerCase("zh-CN").includes(needle)
    ));
    const palette = byId("actionTimelineDefinitionPalette");
    palette.replaceChildren();
    for (const definition of visibleDefinitions) {
      const selected = definition.actionDefinitionId === selectedTimelineDefinitionId;
      const stale = !definitionBindingCurrent(definition);
      const card = document.createElement("div");
      card.className = `action-palette-card${selected ? " selected" : ""}${stale ? " stale" : ""}`;
      card.dataset.actionDefinitionId = definition.actionDefinitionId;
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-current", String(selected));
      card.draggable = !locked;
      card.title = "拖动卡片可直接放到时间轴";

      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "action-palette-select";
      choose.dataset.actionDefinitionId = definition.actionDefinitionId;
      choose.disabled = locked;
      choose.setAttribute("aria-pressed", String(selected));
      const name = document.createElement("b");
      name.textContent = definition.name;
      const meta = document.createElement("small");
      meta.textContent = `${definition.motions.length} 个运动 · ${formatEstimatedDuration(definitionDuration(definition))} · 已放置 ${placementCountByDefinition.get(definition.actionDefinitionId) || 0} 次${stale ? " · ID 已变化" : ""}`;
      choose.append(name, meta);

      const quickAdd = document.createElement("button");
      quickAdd.type = "button";
      quickAdd.className = "action-palette-quick-add";
      quickAdd.dataset.actionDefinitionId = definition.actionDefinitionId;
      quickAdd.textContent = "+";
      quickAdd.disabled = locked || cursorMs > maximumPlacementStartMs(definition);
      quickAdd.setAttribute("aria-label", `将动作 ${definition.name} 添加到当前光标`);
      quickAdd.title = `添加到 ${formatTimelineTime(Math.min(cursorMs, maximumPlacementStartMs(definition)))}`;
      card.append(choose, quickAdd);
      palette.append(card);
    }
    if (!visibleDefinitions.length) {
      const empty = document.createElement("p");
      empty.className = "action-palette-empty";
      empty.textContent = definitions.length
        ? "没有匹配的动作，请更换搜索词"
        : "还没有可用动作\n请先到“动作编辑”页面创建并保存";
      palette.append(empty);
    }
    byId("actionTimelineDefinitionCount").textContent = String(definitions.length);
    renderSelectedDefinitionControl();
  }

  function renderActionTimelineControls(analysis = actionTimelineAnalysis()) {
    const locked = interactionLocked();
    normalizeTimelineDefinitionSelection();
    ensureDefaultActionTrack();
    const stale = analysis.stalePlacements.length > 0;
    const conflicts = analysis.conflictBuckets.length > 0;
    const overflows = analysis.overflowEntries.length > 0;
    renderSelectedDefinitionControl();
    for (const button of document.querySelectorAll(".action-palette-quick-add")) {
      const definition = definitionById(button.dataset.actionDefinitionId);
      button.disabled = locked || !definition || cursorMs > maximumPlacementStartMs(definition);
    }
    byId("actionTimelinePlayButton").disabled = !state.connected || locked || !sequence.size || stale || conflicts || overflows;
    byId("actionTimelineStopButton").disabled = state.timelineRun?.surface !== "actionTimeline" || state.disconnecting;
    byId("actionTimelineDeleteButton").disabled = locked || !selectedPlacementId;
    byId("actionTimelineClearButton").disabled = locked || !sequence.size;
    byId("actionTimelineDurationInput").disabled = locked;
    byId("actionTimelineSnapSelect").disabled = locked;
    byId("actionTimelineZoomInput").disabled = locked;
    byId("actionTimelineSaveProjectButton").disabled = locked;
    byId("actionTimelineImportProjectButton").disabled = locked;
    byId("actionTimelineExportProjectButton").disabled = locked;
    byId("actionTimelineAddTrackButton").disabled = locked
      || actionTracks.size >= actionModel.MAX_ACTION_TRACKS;
    byId("actionTimelineDurationInput").value = String(durationMs / 1_000);
    byId("actionTimelineSnapSelect").value = String(snapMs);
    byId("actionTimelineZoomInput").value = String(pixelsPerSecond);
    byId("actionTimelineTrackCount").textContent = String(actionTracks.size);
    byId("actionTimelinePlacementCount").textContent = String(sequence.size);
    for (const input of document.querySelectorAll(".action-track-name-input")) {
      input.disabled = locked;
    }
    for (const button of document.querySelectorAll(".action-track-delete-button")) {
      button.disabled = locked || actionTracks.size <= 1;
    }
    byId("actionTimelineStatus").textContent = actionTimelineStatusText(analysis);
  }

  function renderActionTimeline() {
    if (!initialized) return;
    const latestEndMs = ensureDurationCoversSequence();
    const analysis = actionTimelineAnalysis();
    const visualDurationMs = Math.min(
      actionModel.MAX_START_MS,
      Math.max(durationMs, Math.ceil(latestEndMs / 1_000) * 1_000),
    );
    const width = Math.max(800, visualDurationMs / 1_000 * pixelsPerSecond);
    const canvas = byId("actionTimelineCanvas");
    canvas.style.setProperty("--action-timeline-width", `${width}px`);
    canvas.style.setProperty("--action-second-width", `${pixelsPerSecond}px`);
    canvas.style.setProperty("--action-minor-width", `${Math.max(5, pixelsPerSecond / 10)}px`);
    renderActionTimelineRuler(visualDurationMs);
    renderActionTimelineTracks(analysis);
    renderActionPalette(analysis);
    renderActionTimelineCursor();
    renderActionTimelineControls(analysis);
  }

  function renderControls() {
    if (!initialized) return;
    if (state.activePage === "actionTimeline") {
      renderActionTimelineControls();
      return;
    }
    const locked = interactionLocked();
    const draftHasConflicts = expandedConflicts(expandedPlanFromMotions(draftMotions)).length > 0;
    byId("namedActionNewButton").disabled = locked;
    byId("namedActionNameInput").disabled = locked;
    byId("namedActionSaveButton").disabled = locked
      || !draftName.trim()
      || !draftMotions.length
      || draftMotions.some((motion) => !motionBindingCurrent(motion))
      || draftHasConflicts;
    byId("namedActionDeleteButton").disabled = locked || !draftDefinitionId;
    byId("namedMotionTestButton").disabled = !state.connected || locked || bindingNodeId(byId("namedMotionMotorSelect").value) == null;
    byId("namedActionTestButton").disabled = !state.connected
      || locked
      || !draftMotions.length
      || draftMotions.some((motion) => !motionBindingCurrent(motion))
      || draftHasConflicts;
    byId("namedActionStopButton").disabled = state.timelineRun?.surface !== "namedAction" || state.disconnecting;
    for (const item of document.querySelectorAll(".named-action-definition-item, .named-motion-remove-button")) {
      item.disabled = locked;
    }
    renderMotionEditor();
    if (state.activePage === "namedAction") renderEditorStatus();
  }

  function renderAll() {
    if (!initialized) return;
    if (state.activePage === "namedAction") renderActionEditor();
    if (state.activePage === "actionTimeline") renderActionTimeline();
  }

  function setSelectedActionTrack(trackId, options = {}) {
    const track = actionTrackById(trackId);
    if (!track) return false;
    selectedTrackId = track.trackId;
    for (const row of document.querySelectorAll(".action-sequence-track-row")) {
      const selected = row.dataset.trackId === selectedTrackId;
      row.querySelector(".action-sequence-track-label")?.classList.toggle("selected", selected);
      row.querySelector(".action-sequence-track-lane")?.classList.toggle("selected", selected);
    }
    if (options.renderControls !== false) renderActionTimelineControls();
    return true;
  }

  function addActionTrack() {
    if (interactionLocked()) return null;
    try {
      const track = actionTracks.add({ name: nextDefaultTrackName() });
      setSelectedActionTrack(track.trackId, { renderControls: false });
      const savedLocally = persistState(true);
      renderActionTimeline();
      toast(
        savedLocally ? `已添加“${track.name}”` : "轨道已添加，但本机保存失败",
        savedLocally ? "info" : "error",
      );
      requestAnimationFrame(() => {
        const input = [...document.querySelectorAll(".action-track-name-input")]
          .find((candidate) => candidate.dataset.trackId === track.trackId);
        input?.focus({ preventScroll: true });
        input?.select();
      });
      return track;
    } catch (error) {
      toast(errorMessage(error), "error");
      renderActionTimelineControls();
      return null;
    }
  }

  function renameActionTrack(event) {
    const input = event?.target?.closest?.(".action-track-name-input");
    if (!input || interactionLocked()) return null;
    const current = actionTrackById(input.dataset.trackId);
    if (!current) return null;
    try {
      if (input.value.trim().normalize("NFC") === current.name) {
        input.value = current.name;
        return current;
      }
      const track = actionTracks.update(current.trackId, { name: input.value });
      const savedLocally = persistState(true);
      input.value = track.name;
      input.setAttribute("aria-label", `轨道名称：${track.name}`);
      const remove = input.closest(".action-sequence-track-label")
        ?.querySelector(".action-track-delete-button");
      if (remove) {
        remove.setAttribute("aria-label", `删除轨道 ${track.name}`);
        remove.title = actionTracks.size <= 1 ? "至少保留一条轨道" : `删除轨道“${track.name}”`;
      }
      renderActionTimelineControls();
      if (!savedLocally) toast("轨道已重命名，但本机保存失败", "error");
      return track;
    } catch (error) {
      input.value = current.name;
      toast(errorMessage(error), "error");
      input.focus({ preventScroll: true });
      input.select();
      return null;
    }
  }

  async function deleteActionTrack(trackId) {
    if (interactionLocked() || actionTracks.size <= 1) return false;
    const track = actionTrackById(trackId);
    if (!track) return false;
    const placementIds = sequence.snapshot()
      .filter((placement) => placement.trackId === track.trackId)
      .map((placement) => placement.placementId);
    const trackRevision = actionTracks.revision;
    const sequenceRevision = sequence.revision;
    if (placementIds.length) {
      const accepted = await confirmAction(
        `删除轨道“${track.name}”`,
        `这会同时删除轨道上的 ${placementIds.length} 个动作实例。`,
        "删除轨道",
      );
      if (!accepted) return false;
    }
    if (
      interactionLocked()
      || actionTracks.size <= 1
      || actionTracks.revision !== trackRevision
      || sequence.revision !== sequenceRevision
      || !actionTrackById(track.trackId)
    ) return false;
    const tracksBeforeRemoval = actionTracks.snapshot();
    const removedTrackIndex = tracksBeforeRemoval.findIndex(({ trackId: candidateId }) => (
      candidateId === track.trackId
    ));
    for (const placementId of placementIds) sequence.remove(placementId);
    actionTracks.remove(track.trackId);
    const remainingTracks = actionTracks.snapshot();
    const fallback = actionTrackById(selectedTrackId)
      || remainingTracks[Math.min(removedTrackIndex, remainingTracks.length - 1)]
      || remainingTracks[0];
    setSelectedActionTrack(fallback.trackId, { renderControls: false });
    if (selectedPlacementId && !sequence.get(selectedPlacementId)) selectedPlacementId = null;
    const savedLocally = persistState(true);
    renderActionTimeline();
    toast(
      savedLocally ? `已删除“${track.name}”` : "轨道已删除，但本机保存失败",
      savedLocally ? "info" : "error",
    );
    return true;
  }

  function addPlacement(actionDefinitionId, requestedStartMs = cursorMs, trackId = selectedTrackId) {
    if (interactionLocked()) return;
    if (!definitionById(actionDefinitionId)) return;
    try {
      const definition = definitionById(actionDefinitionId);
      ensureDefaultActionTrack();
      const track = actionTrackById(trackId);
      if (!track) throw new RangeError("请选择有效的动作轨道");
      if (expandedSequence().length + definition.motions.length > MAX_EXPANDED_MOTIONS) {
        throw new RangeError(`动作时间轴展开后最多允许 ${MAX_EXPANDED_MOTIONS} 个电机运动`);
      }
      const placementStartMs = Math.min(
        timelineModel.snapStartMs(requestedStartMs, 0, durationMs),
        maximumPlacementStartMs(definition),
      );
      const placement = sequence.add({ actionDefinitionId, startMs: placementStartMs, trackId: track.trackId });
      selectedTimelineDefinitionId = actionDefinitionId;
      selectedTrackId = track.trackId;
      selectedPlacementId = placement.placementId;
      durationMs = Math.min(
        actionModel.MAX_START_MS,
        Math.max(durationMs, Math.ceil((placement.startMs + definitionDuration(definition)) / 1_000) * 1_000),
      );
      const savedLocally = persistState(true);
      renderActionTimeline();
      toast(
        savedLocally ? `“${definition.name}”已添加到“${track.name}” ${formatTimelineTime(placement.startMs)}` : "动作已添加，但本机保存失败",
        savedLocally ? "info" : "error",
      );
      return placement;
    } catch (error) {
      toast(errorMessage(error), "error");
      return null;
    }
  }

  function addPlacementAtCursor() {
    return addPlacement(selectedTimelineDefinitionId, cursorMs, selectedTrackId);
  }

  function deleteSelectedPlacement() {
    if (!selectedPlacementId || interactionLocked()) return;
    const removed = sequence.remove(selectedPlacementId);
    selectedPlacementId = null;
    if (removed) {
      const savedLocally = persistState(true);
      renderActionTimeline();
      if (!savedLocally) toast("动作实例已删除，但本机保存失败", "error");
    }
  }

  function clearActionTimeline() {
    if (interactionLocked()) return;
    const removed = sequence.clear();
    selectedPlacementId = null;
    cursorMs = 0;
    const savedLocally = persistState(true);
    renderActionTimeline();
    if (removed) toast(
      savedLocally ? `已清空 ${removed} 个动作实例` : `已清空 ${removed} 个实例，但本机保存失败`,
      savedLocally ? "info" : "error",
    );
  }

  function updateActionTimelineDuration() {
    const seconds = Number(byId("actionTimelineDurationInput").value);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > actionModel.MAX_START_MS / 1_000) {
      byId("actionTimelineDurationInput").value = String(durationMs / 1_000);
      toast("动作时间轴时长必须是 1–600 秒的整数", "error");
      return;
    }
    const next = seconds * 1_000;
    const latestEndMs = latestSequenceEndMs();
    const requiredDurationMs = Math.min(
      actionModel.MAX_START_MS,
      Math.ceil(latestEndMs / 1_000) * 1_000,
    );
    if (next < requiredDurationMs) {
      byId("actionTimelineDurationInput").value = String(durationMs / 1_000);
      toast(
        `现有动作的理论结束时间为 ${Math.ceil(latestEndMs)} ms，时间轴至少需要 ${requiredDurationMs / 1_000} 秒`,
        "error",
      );
      return;
    }
    durationMs = next;
    cursorMs = Math.min(cursorMs, durationMs);
    persistState();
    renderActionTimeline();
  }

  function setCursorFromPointer(event, autoScroll = false) {
    if (autoScroll) {
      const scroller = byId("actionTimelineScroller");
      const bounds = scroller.getBoundingClientRect();
      const canvasStyle = getComputedStyle(byId("actionTimelineCanvas"));
      const labelWidth = Number.parseFloat(canvasStyle.getPropertyValue("--action-label-width")) || 0;
      if (event.clientX < bounds.left + labelWidth + 24) scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 18);
      else if (event.clientX > bounds.right - 28) scroller.scrollLeft += 18;
    }
    const rect = byId("actionTimelineRuler").getBoundingClientRect();
    const milliseconds = timelineModel.millisecondsFromPixels(event.clientX - rect.left, pixelsPerSecond);
    cursorMs = timelineModel.snapStartMs(milliseconds, event.altKey ? 0 : snapMs, durationMs);
    renderActionTimelineCursor();
  }

  function beginCursorDrag(event) {
    if (interactionLocked() || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    const ruler = byId("actionTimelineRuler");
    cursorDrag = { pointerId: event.pointerId };
    ruler.classList.add("dragging");
    byId("actionTimelinePlayhead").classList.add("dragging");
    try {
      ruler.setPointerCapture(event.pointerId);
    } catch (_) {
      cursorDrag = null;
      ruler.classList.remove("dragging");
      byId("actionTimelinePlayhead").classList.remove("dragging");
      return;
    }
    ruler.focus({ preventScroll: true });
    setCursorFromPointer(event);
  }

  function moveCursorDrag(event) {
    if (!cursorDrag || cursorDrag.pointerId !== event.pointerId) return;
    if (interactionLocked()) return finishCursorDrag(event, true);
    event.preventDefault();
    setCursorFromPointer(event, true);
  }

  function finishCursorDrag(event, canceled = false) {
    if (!cursorDrag || cursorDrag.pointerId !== event.pointerId) return;
    if (!canceled && !interactionLocked()) setCursorFromPointer(event);
    cursorDrag = null;
    const ruler = byId("actionTimelineRuler");
    ruler.classList.remove("dragging");
    byId("actionTimelinePlayhead").classList.remove("dragging");
    try {
      if (ruler.hasPointerCapture(event.pointerId)) ruler.releasePointerCapture(event.pointerId);
    } catch (_) {
      // Capture may already be gone after a window blur.
    }
  }

  function moveCursorWithKeyboard(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || interactionLocked()) return;
    event.preventDefault();
    const step = snapMs || 50;
    if (event.key === "Home") cursorMs = 0;
    else if (event.key === "End") cursorMs = durationMs;
    else cursorMs = Math.min(durationMs, Math.max(0, cursorMs + (event.key === "ArrowLeft" ? -step : step)));
    renderActionTimelineCursor();
    followActionTimelineCursor();
  }

  function setSelectedTimelineDefinition(actionDefinitionId, options = {}) {
    if (!definitionById(actionDefinitionId)) return false;
    selectedTimelineDefinitionId = actionDefinitionId;
    if (options.clearPlacement !== false) {
      selectedPlacementId = null;
      for (const clip of document.querySelectorAll(".action-sequence-clip.selected")) {
        clip.classList.remove("selected");
      }
    }
    for (const card of document.querySelectorAll(".action-palette-card")) {
      const selected = card.dataset.actionDefinitionId === actionDefinitionId;
      card.classList.toggle("selected", selected);
      card.setAttribute("aria-current", String(selected));
      card.querySelector(".action-palette-select")?.setAttribute("aria-pressed", String(selected));
    }
    renderActionTimelineControls();
    return true;
  }

  function selectPaletteDefinition(event) {
    const card = event.target.closest(".action-palette-card");
    if (!card || interactionLocked()) return;
    const actionDefinitionId = card.dataset.actionDefinitionId;
    if (!setSelectedTimelineDefinition(actionDefinitionId)) return;
    if (event.target.closest(".action-palette-quick-add")) addPlacementAtCursor();
  }

  function addPaletteDefinitionOnDoubleClick(event) {
    if (event.target.closest(".action-palette-quick-add")) return;
    const card = event.target.closest(".action-palette-card");
    if (!card || interactionLocked()) return;
    if (setSelectedTimelineDefinition(card.dataset.actionDefinitionId)) addPlacementAtCursor();
  }

  function actionTimelineStartFromClientX(clientX, definition, disableSnap = false) {
    const scroller = byId("actionTimelineScroller");
    const bounds = scroller.getBoundingClientRect();
    const canvasStyle = getComputedStyle(byId("actionTimelineCanvas"));
    const labelWidth = Number.parseFloat(canvasStyle.getPropertyValue("--action-label-width")) || 0;
    const pixels = Math.max(0, scroller.scrollLeft + clientX - bounds.left - labelWidth);
    const milliseconds = timelineModel.millisecondsFromPixels(pixels, pixelsPerSecond);
    const maximumStartMs = definition
      ? Math.min(durationMs, maximumPlacementStartMs(definition))
      : durationMs;
    return timelineModel.snapStartMs(
      milliseconds,
      disableSnap ? 0 : snapMs,
      maximumStartMs,
    );
  }

  function actionTrackIdFromClientY(clientY) {
    for (const lane of document.querySelectorAll(".action-sequence-track-lane")) {
      const bounds = lane.getBoundingClientRect();
      if (clientY >= bounds.top && clientY <= bounds.bottom) return lane.dataset.trackId || null;
    }
    return null;
  }

  function showActionTrackDropTarget(trackId) {
    for (const lane of document.querySelectorAll(".action-sequence-track-lane")) {
      lane.classList.toggle("drop-target", lane.dataset.trackId === trackId);
    }
  }

  function beginPaletteDrag(event) {
    const card = event.target.closest(".action-palette-card");
    if (!card || interactionLocked()) {
      event.preventDefault();
      return;
    }
    const definition = definitionById(card.dataset.actionDefinitionId);
    if (!definition) {
      event.preventDefault();
      return;
    }
    setSelectedTimelineDefinition(definition.actionDefinitionId);
    ensureDefaultActionTrack();
    paletteDragDefinitionId = definition.actionDefinitionId;
    paletteDragTrackId = selectedTrackId;
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-lummotor-action", definition.actionDefinitionId);
    event.dataTransfer.setData("text/plain", definition.name);
    if (typeof event.dataTransfer.setDragImage === "function") {
      event.dataTransfer.setDragImage(card, 20, 20);
    }
    byId("actionTimelineStatus").textContent = `正在拖动“${definition.name}”；在右侧时间轴释放即可添加`;
  }

  function movePaletteDrag(event) {
    const definition = definitionById(paletteDragDefinitionId);
    if (!definition || interactionLocked()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const scroller = byId("actionTimelineScroller");
    const bounds = scroller.getBoundingClientRect();
    const canvasStyle = getComputedStyle(byId("actionTimelineCanvas"));
    const labelWidth = Number.parseFloat(canvasStyle.getPropertyValue("--action-label-width")) || 0;
    if (event.clientX < bounds.left + labelWidth + 28) {
      scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 22);
    } else if (event.clientX > bounds.right - 28) {
      scroller.scrollLeft += 22;
    }
    if (event.clientY < bounds.top + 34) scroller.scrollTop = Math.max(0, scroller.scrollTop - 22);
    else if (event.clientY > bounds.bottom - 28) scroller.scrollTop += 22;
    const targetTrackId = actionTrackIdFromClientY(event.clientY);
    if (targetTrackId) {
      paletteDragTrackId = targetTrackId;
      setSelectedActionTrack(targetTrackId, { renderControls: false });
    }
    showActionTrackDropTarget(paletteDragTrackId);
    cursorMs = actionTimelineStartFromClientX(event.clientX, definition, event.altKey);
    scroller.classList.add("drop-ready");
    byId("actionTimelinePlayhead").classList.add("drop-preview");
    renderActionTimelineCursor();
    const track = actionTrackById(paletteDragTrackId);
    byId("actionTimelineStatus").textContent = `释放后把“${definition.name}”添加到“${track?.name || "所选轨道"}” ${formatTimelineTime(cursorMs)}${event.altKey ? " · 未吸附" : ""}`;
  }

  function finishPaletteDrag(restoreStatus = true) {
    paletteDragDefinitionId = null;
    paletteDragTrackId = null;
    for (const card of document.querySelectorAll(".action-palette-card.dragging")) {
      card.classList.remove("dragging");
    }
    byId("actionTimelineScroller").classList.remove("drop-ready");
    byId("actionTimelinePlayhead").classList.remove("drop-preview");
    showActionTrackDropTarget(null);
    if (restoreStatus && initialized) renderActionTimelineControls();
  }

  function dropPaletteAction(event) {
    const actionDefinitionId = paletteDragDefinitionId
      || event.dataTransfer.getData("application/x-lummotor-action");
    const definition = definitionById(actionDefinitionId);
    if (!definition || interactionLocked()) {
      finishPaletteDrag();
      return;
    }
    event.preventDefault();
    cursorMs = actionTimelineStartFromClientX(event.clientX, definition, event.altKey);
    const trackId = actionTrackIdFromClientY(event.clientY)
      || paletteDragTrackId
      || ensureDefaultActionTrack()?.trackId;
    finishPaletteDrag(false);
    addPlacement(actionDefinitionId, cursorMs, trackId);
  }

  function beginPlacementDrag(event) {
    const clip = event.target.closest(".action-sequence-clip");
    if (!clip || interactionLocked() || event.button !== 0) return;
    const placement = sequence.get(clip.dataset.placementId);
    if (!placement) return;
    event.preventDefault();
    selectedPlacementId = placement.placementId;
    selectedTimelineDefinitionId = placement.actionDefinitionId;
    setSelectedActionTrack(placement.trackId, { renderControls: false });
    clip.setPointerCapture(event.pointerId);
    clip.classList.add("dragging");
    placementDrag = {
      pointerId: event.pointerId,
      clip,
      placement,
      startClientX: event.clientX,
      startScrollLeft: byId("actionTimelineScroller").scrollLeft,
      previewStartMs: placement.startMs,
      previewTrackId: placement.trackId,
    };
    renderActionTimelineControls();
  }

  function movePlacementDrag(event) {
    if (!placementDrag || placementDrag.pointerId !== event.pointerId) return;
    const scroller = byId("actionTimelineScroller");
    const bounds = scroller.getBoundingClientRect();
    if (event.clientX < bounds.left + 28) scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 18);
    if (event.clientX > bounds.right - 28) scroller.scrollLeft += 18;
    if (event.clientY < bounds.top + 34) scroller.scrollTop = Math.max(0, scroller.scrollTop - 18);
    if (event.clientY > bounds.bottom - 28) scroller.scrollTop += 18;
    const pixels = event.clientX - placementDrag.startClientX + scroller.scrollLeft - placementDrag.startScrollLeft;
    const milliseconds = placementDrag.placement.startMs
      + timelineModel.millisecondsFromPixels(pixels, pixelsPerSecond);
    const definition = definitionById(placementDrag.placement.actionDefinitionId);
    const maximumStartMs = definition
      ? maximumPlacementStartMs(definition)
      : actionModel.MAX_START_MS;
    placementDrag.previewStartMs = timelineModel.snapStartMs(
      milliseconds,
      event.altKey ? 0 : snapMs,
      Math.min(durationMs, maximumStartMs),
    );
    const targetTrackId = actionTrackIdFromClientY(event.clientY);
    if (targetTrackId && actionTrackById(targetTrackId)) {
      placementDrag.previewTrackId = targetTrackId;
    }
    showActionTrackDropTarget(placementDrag.previewTrackId);
    placementDrag.clip.style.left = `${placementDrag.previewStartMs / 1_000 * pixelsPerSecond}px`;
  }

  function finishPlacementDrag(event, canceled = false) {
    if (!placementDrag || placementDrag.pointerId !== event.pointerId) return;
    const drag = placementDrag;
    placementDrag = null;
    try {
      if (drag.clip.hasPointerCapture(event.pointerId)) drag.clip.releasePointerCapture(event.pointerId);
    } catch (_) {
      // Capture may already be gone after cancel.
    }
    showActionTrackDropTarget(null);
    if (!canceled && !interactionLocked()) {
      const changed = drag.previewStartMs !== drag.placement.startMs
        || drag.previewTrackId !== drag.placement.trackId;
      if (changed) {
        const updated = sequence.update(drag.placement.placementId, {
          startMs: drag.previewStartMs,
          trackId: drag.previewTrackId,
        });
        selectedPlacementId = updated.placementId;
        selectedTrackId = updated.trackId;
        cursorMs = updated.startMs;
        ensureDurationCoversSequence();
        if (!persistState(true)) toast("动作已移动，但本机保存失败", "error");
      }
    }
    renderActionTimeline();
  }

  function selectActionTimelineTarget(event) {
    const deleteButton = event.target.closest(".action-track-delete-button");
    if (deleteButton) {
      void deleteActionTrack(deleteButton.dataset.trackId);
      return;
    }
    const clip = event.target.closest(".action-sequence-clip");
    if (clip) {
      const placement = sequence.get(clip.dataset.placementId);
      if (!placement) return;
      selectedPlacementId = placement.placementId;
      selectedTimelineDefinitionId = placement.actionDefinitionId;
      selectedTrackId = placement.trackId;
      cursorMs = placement.startMs;
      renderActionTimeline();
      return;
    }
    const target = event.target.closest(".action-sequence-track-label, .action-sequence-track-lane");
    if (!target?.dataset.trackId) return;
    setSelectedActionTrack(target.dataset.trackId);
  }

  function expandedPlanFromMotions(motions, placementOffset = 0, metadata = {}) {
    return motions.map((motion) => ({
      ...metadata,
      motion,
      startMs: placementOffset + motion.startMs,
    }));
  }

  function groupsFromExpanded(expanded) {
    const groups = [];
    for (const entry of [...expanded].sort((left, right) => left.startMs - right.startMs)) {
      const previous = groups.at(-1);
      const item = { action: entry.motion, command: timelineCommand(entry.motion) };
      if (previous && previous.startMs === entry.startMs) previous.items.push(item);
      else groups.push({ startMs: entry.startMs, items: [item] });
    }
    return groups;
  }

  function validateExpandedPlan(expanded) {
    if (!expanded.length) throw new Error("动作中还没有电机运动");
    if (expanded.length > MAX_EXPANDED_MOTIONS) {
      throw new RangeError(`一次最多展开 ${MAX_EXPANDED_MOTIONS} 个电机运动`);
    }
    const stale = expanded.find(({ motion }) => !motionBindingCurrent(motion));
    if (stale) {
      throw new Error(`${motorById(stale.motion.motorId)?.label || stale.motion.motorId} 保存的 ID ${stale.motion.nodeId} 与当前绑定不一致`);
    }
    const overflow = expanded.find(({ startMs }) => startMs > actionModel.MAX_START_MS);
    if (overflow) throw new RangeError("动作展开后的发送时间超过 10:00");
    const conflicts = expandedConflicts(expanded);
    if (conflicts.length) {
      const [{ startMs, motion }] = conflicts[0];
      throw new Error(`${startMs} ms 的节点 ID ${motion.nodeId} 有多个电机运动，不能同时执行`);
    }
  }

  async function playExpandedPlan(expanded, options) {
    if (!state.connected || interactionLocked()) return;
    try {
      validateExpandedPlan(expanded);
      const groups = groupsFromExpanded(expanded);
      const commands = groups.flatMap(({ items }) => items.map(({ command }) => command));
      const operationEpoch = state.operationEpoch;
      const connectionEpoch = state.connectionEpoch;
      const libraryRevision = library.revision;
      const sequenceRevision = sequence.revision;
      const draftSignature = options.surface === "namedAction" ? JSON.stringify(draftMotions) : null;
      if (!await requireIdleNodes(commands)) return;
      if (
        !state.connected
        || state.busy
        || state.configIoBusy
        || state.disconnecting
        || state.operationEpoch !== operationEpoch
        || state.connectionEpoch !== connectionEpoch
        || library.revision !== libraryRevision
        || (options.surface === "actionTimeline" && sequence.revision !== sequenceRevision)
        || (options.surface === "namedAction" && JSON.stringify(draftMotions) !== draftSignature)
      ) {
        toast("预检期间动作、ID 或连接状态已变化，本次未播放", "warning");
        return;
      }
      validateExpandedPlan(expanded);
      launchNamedTimelineRun({
        surface: options.surface,
        sourceLabel: options.sourceLabel,
        completionLabel: options.completionLabel,
        operationLabel: options.operationLabel,
        groups,
        durationMs: options.durationMs,
        placementCount: options.placementCount,
        definitionCount: options.definitionCount,
      });
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function testCurrentMotion() {
    let motion;
    try {
      motion = motionDraftFromForm();
    } catch (error) {
      toast(errorMessage(error), "error");
      return;
    }
    const immediateMotion = { ...motion, startMs: 0 };
    const expanded = expandedPlanFromMotions([immediateMotion]);
    await playExpandedPlan(expanded, {
      surface: "namedAction",
      sourceLabel: "动作编辑测试",
      completionLabel: "电机运动测试完成",
      operationLabel: "测试动作中的电机运动",
      durationMs: Math.max(1, definitionDuration([immediateMotion])),
      definitionCount: 1,
    });
  }

  async function testDraftDefinition() {
    const expanded = expandedPlanFromMotions(draftMotions);
    await playExpandedPlan(expanded, {
      surface: "namedAction",
      sourceLabel: "动作编辑测试",
      completionLabel: "命名动作测试完成",
      operationLabel: "测试命名动作",
      durationMs: Math.max(1, definitionDuration(draftMotions)),
      definitionCount: 1,
    });
  }

  async function playActionTimeline() {
    const placements = sequence.snapshot();
    const expanded = placements.flatMap((placement) => {
      const definition = definitionById(placement.actionDefinitionId);
      return definition
        ? expandedPlanFromMotions(definition.motions, placement.startMs, { placement, definition })
        : [];
    });
    await playExpandedPlan(expanded, {
      surface: "actionTimeline",
      sourceLabel: "动作时间轴",
      completionLabel: "动作时间轴播放完成",
      operationLabel: "动作时间轴播放",
      durationMs,
      placementCount: placements.length,
      definitionCount: new Set(placements.map(({ actionDefinitionId }) => actionDefinitionId)).size,
    });
  }

  function saveActionTimelineProject() {
    if (interactionLocked()) return;
    const saved = persistState(true);
    toast(
      saved
        ? `动作时间轴已保存到本机 · ${library.size} 个动作 · ${actionTracks.size} 条轨道 · ${sequence.size} 个实例`
        : "动作时间轴本机保存失败",
      saved ? "info" : "error",
    );
  }

  function exportActionTimelineDocument() {
    ensureDefaultActionTrack();
    ensureDurationCoversSequence();
    const latestSendMs = latestSequenceSendMs();
    if (latestSendMs > durationMs) {
      throw new RangeError(`动作时间轴时长 ${durationMs} ms 小于最后发送时间 ${latestSendMs} ms`);
    }
    return {
      format: ACTION_TIMELINE_FILE_FORMAT,
      schemaVersion: ACTION_TIMELINE_FILE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      motorCount: state.motors.length,
      motors: state.motors.map(({ id, label }) => ({ motorId: id, label })),
      namedActions: {
        schemaVersion: 1,
        definitions: library.snapshot(),
      },
      actionTimeline: {
        schemaVersion: 2,
        durationMs,
        snapMs,
        pixelsPerSecond,
        tracks: actionTracks.snapshot(),
        placements: sequence.snapshot(),
      },
    };
  }

  async function exportActionTimelineProject() {
    if (interactionLocked()) return;
    state.configIoBusy = true;
    renderConnection();
    try {
      const content = `${JSON.stringify(exportActionTimelineDocument(), null, 2)}\n`;
      const result = await api.exportActionTimelineFile(content);
      if (!result?.canceled) {
        toast(`动作时间轴已导出：${result.fileName || "JSON 文件"}`);
      }
    } catch (error) {
      toast(`动作时间轴导出失败：${errorMessage(error)}`, "error");
    } finally {
      state.configIoBusy = false;
      renderConnection();
    }
  }

  function normalizeImportedActionTimeline(content) {
    if (typeof content !== "string") throw new TypeError("动作时间轴文件内容不合法");
    let parsed;
    try {
      parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
    } catch (_) {
      throw new TypeError("动作时间轴文件不是有效 JSON");
    }
    const documentRecord = configurationRecord(parsed, "动作时间轴文件");
    configurationOnlyKeys(
      documentRecord,
      ["format", "schemaVersion", "exportedAt", "motorCount", "motors", "namedActions", "actionTimeline"],
      "动作时间轴文件",
    );
    if (documentRecord.format !== ACTION_TIMELINE_FILE_FORMAT) {
      throw new TypeError("不是 Action Editor 导出的动作时间轴文件");
    }
    if (documentRecord.schemaVersion !== ACTION_TIMELINE_FILE_SCHEMA_VERSION) {
      throw new RangeError(`不支持的动作时间轴文件版本: ${documentRecord.schemaVersion}`);
    }
    configurationExportedAt(documentRecord.exportedAt, "动作时间轴文件");
    const motorCount = configurationInteger(
      documentRecord.motorCount,
      "动作时间轴电机引用数量",
      0,
      motorRegistry.MAX_MOTORS,
    );
    if (!Array.isArray(documentRecord.motors)) throw new TypeError("动作时间轴缺少电机引用快照");
    if (documentRecord.motors.length !== motorCount) {
      throw new RangeError("动作时间轴电机引用数量不匹配");
    }
    const importedMotors = motorRegistry.normalizeMotorCatalog(documentRecord.motors.map(
      (rawMotor, index) => {
        const motor = configurationRecord(rawMotor, `第 ${index + 1} 个动作时间轴电机引用`);
        configurationOnlyKeys(motor, ["motorId", "label"], `第 ${index + 1} 个动作时间轴电机引用`);
        return {
          id: motorRegistry.normalizeMotorId(motor.motorId),
          label: motorRegistry.normalizeMotorLabel(motor.label),
          group: motorRegistry.CUSTOM_GROUP_ID,
        };
      },
    ));
    const importedMotorIds = new Set(importedMotors.map(({ id }) => id));

    const namedActions = configurationRecord(documentRecord.namedActions, "命名动作库");
    configurationOnlyKeys(namedActions, ["schemaVersion", "definitions"], "命名动作库");
    if (namedActions.schemaVersion !== 1) {
      throw new RangeError(`不支持的命名动作库版本: ${namedActions.schemaVersion}`);
    }
    if (!Array.isArray(namedActions.definitions)) throw new TypeError("命名动作定义必须是数组");
    if (namedActions.definitions.length > actionModel.MAX_ACTION_DEFINITIONS) {
      throw new RangeError(`最多可以导入 ${actionModel.MAX_ACTION_DEFINITIONS} 个命名动作`);
    }
    for (const [definitionIndex, rawDefinition] of namedActions.definitions.entries()) {
      const definition = configurationRecord(rawDefinition, `第 ${definitionIndex + 1} 个命名动作`);
      configurationOnlyKeys(
        definition,
        ["actionDefinitionId", "name", "motions"],
        `第 ${definitionIndex + 1} 个命名动作`,
      );
      actionTimelineFileStableId(definition.actionDefinitionId, "actionDefinitionId");
      if (!Array.isArray(definition.motions)) throw new TypeError("命名动作的电机运动必须是数组");
      for (const [motionIndex, rawMotion] of definition.motions.entries()) {
        const motion = configurationRecord(
          rawMotion,
          `第 ${definitionIndex + 1} 个命名动作的第 ${motionIndex + 1} 个电机运动`,
        );
        configurationOnlyKeys(
          motion,
          ["motionId", "motorId", "nodeId", "startMs", "signedSteps", "speed", "acceleration", "closed"],
          `第 ${definitionIndex + 1} 个命名动作的第 ${motionIndex + 1} 个电机运动`,
        );
        actionTimelineFileStableId(motion.motionId, "motionId");
        if (typeof motion.closed !== "boolean") throw new TypeError("电机运动的闭环模式必须是布尔值");
      }
    }
    const importedLibrary = new actionModel.ActionLibrary(namedActions.definitions);

    const timeline = configurationRecord(documentRecord.actionTimeline, "动作时间轴");
    configurationOnlyKeys(
      timeline,
      ["schemaVersion", "durationMs", "snapMs", "pixelsPerSecond", "tracks", "placements"],
      "动作时间轴",
    );
    if (timeline.schemaVersion !== 2) {
      throw new RangeError(`不支持的动作时间轴数据版本: ${timeline.schemaVersion}`);
    }
    const importedDurationMs = configurationInteger(
      timeline.durationMs,
      "动作时间轴时长",
      1_000,
      actionModel.MAX_START_MS,
    );
    const importedSnapMs = configurationInteger(timeline.snapMs, "动作时间轴吸附", 0, 1_000);
    if (!SNAP_OPTIONS.has(importedSnapMs)) throw new RangeError("动作时间轴吸附间隔不受支持");
    const importedPixelsPerSecond = configurationInteger(
      timeline.pixelsPerSecond,
      "动作时间轴缩放",
      50,
      240,
    );
    if (!Array.isArray(timeline.tracks)) throw new TypeError("动作轨道必须是数组");
    if (timeline.tracks.length < 1 || timeline.tracks.length > actionModel.MAX_ACTION_TRACKS) {
      throw new RangeError(`动作时间轴必须包含 1–${actionModel.MAX_ACTION_TRACKS} 条轨道`);
    }
    for (const [trackIndex, rawTrack] of timeline.tracks.entries()) {
      const track = configurationRecord(rawTrack, `第 ${trackIndex + 1} 条动作轨道`);
      configurationOnlyKeys(track, ["trackId", "name"], `第 ${trackIndex + 1} 条动作轨道`);
      actionTimelineFileStableId(track.trackId, "trackId");
    }
    const importedTracks = new actionModel.ActionTrackCatalog(timeline.tracks);

    if (!Array.isArray(timeline.placements)) throw new TypeError("动作时间轴实例必须是数组");
    if (timeline.placements.length > actionModel.MAX_PLACEMENTS) {
      throw new RangeError(`动作时间轴最多可以导入 ${actionModel.MAX_PLACEMENTS} 个实例`);
    }
    for (const [placementIndex, rawPlacement] of timeline.placements.entries()) {
      const placement = configurationRecord(rawPlacement, `第 ${placementIndex + 1} 个动作实例`);
      configurationOnlyKeys(
        placement,
        ["placementId", "actionDefinitionId", "trackId", "startMs"],
        `第 ${placementIndex + 1} 个动作实例`,
      );
      actionTimelineFileStableId(placement.placementId, "placementId");
      actionTimelineFileStableId(placement.actionDefinitionId, "actionDefinitionId");
      actionTimelineFileStableId(placement.trackId, "trackId");
    }
    const importedSequence = new actionModel.NamedActionTimeline(timeline.placements);

    for (const definition of importedLibrary.snapshot()) {
      for (const motion of definition.motions) {
        if (!importedMotorIds.has(motion.motorId)) {
          throw new RangeError(`动作“${definition.name}”引用了文件中不存在的电机位置: ${motion.motorId}`);
        }
        if (!hasMotor(motion.motorId)) {
          throw new RangeError(`当前电机配置缺少动作引用的位置: ${motion.motorId}`);
        }
      }
    }
    let expandedMotionCount = 0;
    let latestAbsoluteSendMs = 0;
    for (const placement of importedSequence.snapshot()) {
      const definition = importedLibrary.get(placement.actionDefinitionId);
      if (!definition) throw new RangeError(`动作实例引用了不存在的命名动作: ${placement.actionDefinitionId}`);
      if (!importedTracks.get(placement.trackId)) {
        throw new RangeError(`动作实例引用了不存在的轨道: ${placement.trackId}`);
      }
      expandedMotionCount += definition.motions.length;
      if (expandedMotionCount > MAX_EXPANDED_MOTIONS) {
        throw new RangeError(`动作时间轴展开后最多允许 ${MAX_EXPANDED_MOTIONS} 个电机运动`);
      }
      for (const motion of definition.motions) {
        const absoluteSendMs = placement.startMs + motion.startMs;
        if (absoluteSendMs > actionModel.MAX_START_MS) {
          throw new RangeError(`动作“${definition.name}”的发送时间超过 10:00`);
        }
        latestAbsoluteSendMs = Math.max(latestAbsoluteSendMs, absoluteSendMs);
      }
    }
    if (latestAbsoluteSendMs > importedDurationMs) {
      throw new RangeError(`动作时间轴时长 ${importedDurationMs} ms 小于最后发送时间 ${latestAbsoluteSendMs} ms`);
    }
    return {
      library: importedLibrary,
      actionTracks: importedTracks,
      sequence: importedSequence,
      durationMs: importedDurationMs,
      snapMs: importedSnapMs,
      pixelsPerSecond: importedPixelsPerSecond,
    };
  }

  async function importActionTimelineProject() {
    if (interactionLocked()) return;
    const operationEpoch = state.operationEpoch;
    const connectionEpoch = state.connectionEpoch;
    const libraryRevision = library.revision;
    const tracksRevision = actionTracks.revision;
    const sequenceRevision = sequence.revision;
    let committed = false;
    state.configIoBusy = true;
    cancelInteractions();
    renderConnection();
    try {
      const result = await api.importActionTimelineFile();
      if (result?.canceled) return;
      if (
        state.busy
        || state.connecting
        || state.disconnecting
        || state.operationEpoch !== operationEpoch
        || state.connectionEpoch !== connectionEpoch
        || library.revision !== libraryRevision
        || actionTracks.revision !== tracksRevision
        || sequence.revision !== sequenceRevision
      ) {
        throw new Error("导入期间运行状态已变化，未应用动作时间轴");
      }
      const imported = normalizeImportedActionTimeline(result?.content);
      if (draftIsDirty()) {
        const accepted = await confirmAction(
          "导入并替换动作时间轴",
          "当前动作有未保存修改。继续会替换整个命名动作库、全部轨道和动作实例。",
          "替换并导入",
        );
        if (!accepted) return;
        if (
          state.busy
          || state.connecting
          || state.disconnecting
          || state.operationEpoch !== operationEpoch
          || state.connectionEpoch !== connectionEpoch
          || library.revision !== libraryRevision
          || actionTracks.revision !== tracksRevision
          || sequence.revision !== sequenceRevision
        ) {
          throw new Error("确认期间运行状态已变化，未应用动作时间轴");
        }
      }
      library = imported.library;
      actionTracks = imported.actionTracks;
      sequence = imported.sequence;
      durationMs = imported.durationMs;
      snapMs = imported.snapMs;
      pixelsPerSecond = imported.pixelsPerSecond;
      cursorMs = 0;
      actionSearchQuery = "";
      selectedPlacementId = null;
      selectedTrackId = actionTracks.snapshot()[0].trackId;
      const firstDefinition = library.snapshot()[0] || null;
      selectedDefinitionId = firstDefinition?.actionDefinitionId || null;
      selectedTimelineDefinitionId = selectedDefinitionId;
      draftDefinitionId = selectedDefinitionId;
      draftName = firstDefinition?.name || "";
      draftMotions = firstDefinition ? cloneMotions(firstDefinition.motions) : [];
      resetNamedMotionTimeline();
      selectedDraftMotionIndex = null;
      definitionDurationCache = new WeakMap();
      ensureDurationCoversSequence();
      committed = true;
      byId("namedActionNameInput").value = draftName;
      byId("actionTimelineSearchInput").value = "";
      resetMotionEditor();
      const saved = persistState(true);
      renderActionEditor();
      renderActionTimeline();
      if (state.connected) refreshMotionProfiles();
      const staleMotions = library.snapshot().flatMap((definition) => (
        definition.motions.filter((motion) => !motionBindingCurrent(motion))
      ));
      const staleDefinitions = library.snapshot().filter((definition) => (
        definition.motions.some((motion) => !motionBindingCurrent(motion))
      ));
      const summary = `${library.size} 个动作 · ${actionTracks.size} 条轨道 · ${sequence.size} 个实例`;
      const importedMessage = saved
        ? `动作时间轴已导入并保存：${result.fileName || "JSON 文件"} · ${summary}`
        : `动作时间轴已导入，但本机保存失败 · ${summary}`;
      if (staleMotions.length) {
        toast(
          `${importedMessage}；${staleDefinitions.length} 个动作中的 ${staleMotions.length} 个电机运动 ID 与当前绑定不一致，已标记失效`,
          saved ? "warning" : "error",
        );
      } else {
        toast(importedMessage, saved ? "info" : "error");
      }
    } catch (error) {
      toast(
        committed
          ? `动作时间轴已经导入，但界面刷新失败：${errorMessage(error)}`
          : `动作时间轴导入失败：${errorMessage(error)}；未修改现有动作工程`,
        "error",
      );
    } finally {
      state.configIoBusy = false;
      renderConnection();
    }
  }

  function followActionTimelineCursor() {
    if (state.activePage !== "actionTimeline") return;
    const scroller = byId("actionTimelineScroller");
    const canvasStyle = getComputedStyle(byId("actionTimelineCanvas"));
    const labelWidth = Number.parseFloat(canvasStyle.getPropertyValue("--action-label-width")) || 0;
    const cursorPixels = cursorMs / 1_000 * pixelsPerSecond;
    const contentX = labelWidth + cursorPixels;
    const left = scroller.scrollLeft + labelWidth + 24;
    const right = scroller.scrollLeft + scroller.clientWidth - 36;
    if (contentX > right) scroller.scrollLeft = Math.max(0, contentX - scroller.clientWidth + 56);
    else if (contentX < left) scroller.scrollLeft = Math.max(0, cursorPixels - 24);
  }

  function preparePlayback(run) {
    if (run.surface === "actionTimeline") {
      cursorMs = 0;
      byId("actionTimelineScroller").scrollLeft = 0;
    } else if (run.surface === "namedAction") {
      namedMotionCursorMs = 0;
      byId("namedMotionTimelineScroller").scrollLeft = 0;
    }
  }

  function updatePlaybackCursor(run, elapsed) {
    if (run.surface === "actionTimeline") {
      cursorMs = Math.min(run.durationMs, Math.round(elapsed));
      renderActionTimelineCursor();
      followActionTimelineCursor();
    } else if (run.surface === "namedAction") {
      namedMotionCursorMs = Math.min(run.durationMs, Math.round(elapsed));
      renderNamedMotionTimelineCursor();
      followNamedMotionCursor();
    }
  }

  function renderPlaybackStatus(run) {
    if (run.surface === "actionTimeline") {
      byId("actionTimelineStatus").textContent = actionTimelineStatusText();
    } else {
      renderEditorStatus();
    }
  }

  function finishPlayback(run) {
    if (run.surface === "actionTimeline") cursorMs = run.durationMs;
    if (run.surface === "namedAction") namedMotionCursorMs = run.durationMs;
  }

  function renderPlaybackSurface(run) {
    if (run.surface === "actionTimeline") renderActionTimeline();
    else renderActionEditor();
  }

  function cancelInteractions() {
    if (namedMotionCursorDrag) {
      finishNamedMotionCursorDrag({ pointerId: namedMotionCursorDrag.pointerId }, true);
    }
    if (namedMotionClipDrag) {
      finishNamedMotionClipDrag({ pointerId: namedMotionClipDrag.pointerId }, true);
    }
    if (cursorDrag) finishCursorDrag({ pointerId: cursorDrag.pointerId }, true);
    if (placementDrag) finishPlacementDrag({ pointerId: placementDrag.pointerId }, true);
    if (paletteDragDefinitionId) finishPaletteDrag();
  }

  function motionProfilesChanged() {
    definitionDurationCache = new WeakMap();
    if (!initialized || profileRefreshHandle != null) return;
    profileRefreshHandle = requestAnimationFrame(() => {
      profileRefreshHandle = null;
      if (namedMotionCursorDrag || namedMotionClipDrag) cancelInteractions();
      const previousDurationMs = durationMs;
      ensureDurationCoversSequence();
      if (durationMs !== previousDurationMs) persistState();
      if (state.activePage === "namedAction") renderActionEditor();
      if (state.activePage === "actionTimeline") renderActionTimeline();
    });
  }

  function refreshMotionProfiles() {
    if (!state.connected) return;
    const nodeIds = new Set();
    for (const definition of library.snapshot()) {
      for (const motion of definition.motions) nodeIds.add(motion.nodeId);
    }
    for (const nodeId of nodeIds) void ensureMotionProfile(nodeId);
  }

  function motorCatalogRemovalImpact(allowedMotorIds) {
    const affected = library.snapshot().filter((definition) => (
      definition.motions.some(({ motorId }) => !allowedMotorIds.has(motorId))
    ));
    const affectedIds = new Set(affected.map(({ actionDefinitionId }) => actionDefinitionId));
    return {
      removedDefinitions: affected.length,
      removedNamedMotions: affected.reduce((sum, definition) => sum + definition.motions.length, 0),
      removedPlacements: sequence.snapshot().filter(({ actionDefinitionId }) => affectedIds.has(actionDefinitionId)).length,
    };
  }

  function reconcileMotorCatalog(allowedMotorIds) {
    const impact = motorCatalogRemovalImpact(allowedMotorIds);
    const affectedIds = new Set(library.snapshot()
      .filter((definition) => definition.motions.some(({ motorId }) => !allowedMotorIds.has(motorId)))
      .map(({ actionDefinitionId }) => actionDefinitionId));
    for (const placement of sequence.snapshot()) {
      if (affectedIds.has(placement.actionDefinitionId)) sequence.remove(placement.placementId);
    }
    for (const actionDefinitionId of affectedIds) library.remove(actionDefinitionId);
    if (affectedIds.has(draftDefinitionId)) {
      draftDefinitionId = null;
      selectedDefinitionId = null;
      draftName = "";
      draftMotions = [];
      selectedDraftMotionIndex = null;
      resetNamedMotionTimeline();
    } else {
      const keptDraftMotions = draftMotions.filter(({ motorId }) => allowedMotorIds.has(motorId));
      if (keptDraftMotions.length !== draftMotions.length) {
        draftMotions = keptDraftMotions;
        selectedDraftMotionIndex = null;
        resetNamedMotionTimeline();
      }
    }
    if (affectedIds.has(selectedTimelineDefinitionId)) {
      selectedTimelineDefinitionId = library.snapshot()[0]?.actionDefinitionId || null;
    }
    if (selectedPlacementId && !sequence.get(selectedPlacementId)) selectedPlacementId = null;
    if (initialized) {
      populateMotorSelect();
      renderAll();
    }
    return impact;
  }

  function loadStoredState(stored, rawStoredState = "null") {
    library = new actionModel.ActionLibrary();
    sequence = new actionModel.NamedActionTimeline();
    actionTracks = new actionModel.ActionTrackCatalog();
    let recoveredInvalidData = false;
    const definitions = Array.isArray(stored?.namedActions?.definitions)
      ? stored.namedActions.definitions
      : [];
    if (stored?.namedActions?.definitions !== undefined && !Array.isArray(stored.namedActions.definitions)) {
      recoveredInvalidData = true;
    }
    if (definitions.length > actionModel.MAX_ACTION_DEFINITIONS) recoveredInvalidData = true;
    for (const definition of definitions.slice(0, actionModel.MAX_ACTION_DEFINITIONS)) {
      if (
        !Array.isArray(definition?.motions)
        || definition.motions.some((motion) => (
          !motion
          || typeof motion !== "object"
          || Array.isArray(motion)
          || !hasMotor(motion.motorId)
        ))
      ) {
        recoveredInvalidData = true;
        continue;
      }
      try {
        library.add(definition);
      } catch (_) {
        recoveredInvalidData = true;
      }
    }
    const actionTimelineSchemaVersion = stored?.actionTimeline?.schemaVersion;
    const usesTrackSchema = actionTimelineSchemaVersion === 2;
    const usesLegacyTrackSchema = actionTimelineSchemaVersion === undefined
      || actionTimelineSchemaVersion === 1;
    if (!usesTrackSchema && !usesLegacyTrackSchema) recoveredInvalidData = true;
    const legacyTrackByDefinition = new Map();
    if (usesTrackSchema) {
      const storedTracks = Array.isArray(stored?.actionTimeline?.tracks)
        ? stored.actionTimeline.tracks
        : [];
      if (!Array.isArray(stored?.actionTimeline?.tracks)) recoveredInvalidData = true;
      if (storedTracks.length > actionModel.MAX_ACTION_TRACKS) recoveredInvalidData = true;
      for (const track of storedTracks.slice(0, actionModel.MAX_ACTION_TRACKS)) {
        try {
          actionTracks.add(track);
        } catch (_) {
          recoveredInvalidData = true;
        }
      }
      if (!actionTracks.size) recoveredInvalidData = true;
    } else {
      for (const [index, definition] of library.snapshot().entries()) {
        const maximumLength = actionModel.MAX_ACTION_TRACK_NAME_LENGTH;
        const baseName = [...definition.name].slice(0, maximumLength).join("");
        let candidateName = baseName || `轨道 ${index + 1}`;
        let suffix = 2;
        while (actionTracks.snapshot().some(({ name }) => name === candidateName)) {
          const ending = ` ${suffix}`;
          candidateName = `${[...baseName].slice(0, maximumLength - [...ending].length).join("")}${ending}`;
          suffix += 1;
        }
        try {
          const track = actionTracks.add({ name: candidateName });
          legacyTrackByDefinition.set(definition.actionDefinitionId, track.trackId);
        } catch (_) {
          recoveredInvalidData = true;
        }
      }
    }
    if (!actionTracks.size) actionTracks.add({ name: "轨道 1" });
    selectedTrackId = actionTracks.snapshot()[0].trackId;
    const placements = Array.isArray(stored?.actionTimeline?.placements)
      ? stored.actionTimeline.placements
      : [];
    if (stored?.actionTimeline?.placements !== undefined && !Array.isArray(stored.actionTimeline.placements)) {
      recoveredInvalidData = true;
    }
    if (placements.length > actionModel.MAX_PLACEMENTS) recoveredInvalidData = true;
    let expandedMotionCount = 0;
    for (const placement of placements.slice(0, actionModel.MAX_PLACEMENTS)) {
      let validatedPlacement;
      try {
        validatedPlacement = actionModel.validatePlacement(placement);
      } catch (_) {
        recoveredInvalidData = true;
        continue;
      }
      const definition = definitionById(validatedPlacement.actionDefinitionId);
      if (!definition) {
        recoveredInvalidData = true;
        continue;
      }
      if (expandedMotionCount + definition.motions.length > MAX_EXPANDED_MOTIONS) {
        recoveredInvalidData = true;
        continue;
      }
      try {
        let trackId = selectedTrackId;
        if (usesTrackSchema) {
          if (validatedPlacement.trackId && actionTrackById(validatedPlacement.trackId)) {
            trackId = validatedPlacement.trackId;
          } else {
            recoveredInvalidData = true;
          }
        } else {
          trackId = legacyTrackByDefinition.get(validatedPlacement.actionDefinitionId)
            || selectedTrackId;
        }
        sequence.add({
          ...(validatedPlacement.placementId === undefined
            ? {}
            : { placementId: validatedPlacement.placementId }),
          actionDefinitionId: validatedPlacement.actionDefinitionId,
          startMs: validatedPlacement.startMs,
          trackId,
        });
        expandedMotionCount += definition.motions.length;
      } catch (_) {
        recoveredInvalidData = true;
      }
    }
    const storedDuration = Number(stored?.actionTimeline?.durationMs);
    durationMs = Number.isSafeInteger(storedDuration)
      && storedDuration >= 1_000
      && storedDuration <= actionModel.MAX_START_MS
      ? storedDuration
      : DEFAULT_DURATION_MS;
    const storedSnap = Number(stored?.actionTimeline?.snapMs);
    snapMs = SNAP_OPTIONS.has(storedSnap) ? storedSnap : DEFAULT_SNAP_MS;
    const storedScale = Number(stored?.actionTimeline?.pixelsPerSecond);
    pixelsPerSecond = Number.isSafeInteger(storedScale) && storedScale >= 50 && storedScale <= 240
      ? storedScale
      : DEFAULT_PIXELS_PER_SECOND;
    ensureDurationCoversSequence();
    selectedDefinitionId = library.snapshot()[0]?.actionDefinitionId || null;
    selectedTimelineDefinitionId = selectedDefinitionId;
    selectedPlacementId = null;
    ensureDefaultActionTrack();
    if (recoveredInvalidData) preserveLocalRecoveryCopy(rawStoredState);
  }

  function persistedStateFields() {
    return {
      namedActions: {
        schemaVersion: 1,
        definitions: library.snapshot(),
      },
      actionTimeline: {
        schemaVersion: 2,
        tracks: actionTracks.snapshot(),
        durationMs,
        snapMs,
        pixelsPerSecond,
        placements: sequence.snapshot(),
      },
    };
  }

  function initialize() {
    ensureDefaultActionTrack();
    initialized = true;
    populateMotorSelect();
    const initial = definitionById(selectedDefinitionId);
    if (initial) {
      draftDefinitionId = initial.actionDefinitionId;
      draftName = initial.name;
      draftMotions = cloneMotions(initial.motions);
      byId("namedActionNameInput").value = draftName;
    } else {
      draftDefinitionId = null;
      draftName = "";
      draftMotions = [];
    }
    resetNamedMotionTimeline();
    resetMotionEditor();
    renderAll();
  }

  function renderPage(page) {
    if (page === "namedAction") renderActionEditor();
    if (page === "actionTimeline") renderActionTimeline();
    refreshMotionProfiles();
  }

  function initEvents() {
    byId("namedActionNewButton").addEventListener("click", () => void startNewDefinition());
    byId("namedActionNameInput").addEventListener("input", (event) => {
      draftName = event.target.value;
      renderDefinitionForm();
      renderNamedMotionSummary();
      renderControls();
    });
    byId("namedActionSaveButton").addEventListener("click", saveDefinition);
    byId("namedActionDeleteButton").addEventListener("click", () => void deleteDefinition());
    byId("namedActionDefinitionList").addEventListener("click", (event) => {
      const item = event.target.closest(".named-action-definition-item");
      if (item) void loadDefinition(item.dataset.actionDefinitionId);
    });
    byId("namedMotionMotorSelect").addEventListener("change", () => {
      renderMotionBindingHint();
      renderMotionEditor();
    });
    byId("namedMotionStartInput").addEventListener("input", syncNamedMotionCursorFromInput);
    byId("namedMotionSnapSelect").addEventListener("change", (event) => {
      const next = Number(event.target.value);
      if (!SNAP_OPTIONS.has(next)) return;
      namedMotionSnapMs = next;
    });
    byId("namedMotionDirectionButtons").addEventListener("click", (event) => {
      const button = event.target.closest(".named-motion-direction-button");
      if (button && !interactionLocked()) setMotionDirection(Number(button.dataset.direction));
    });
    byId("namedMotionForm").addEventListener("submit", (event) => {
      event.preventDefault();
      addDraftMotion();
    });
    byId("namedMotionUpdateButton").addEventListener("click", updateDraftMotion);
    byId("namedMotionCancelEditButton").addEventListener("click", () => {
      resetMotionEditor();
      renderAll();
    });
    byId("namedMotionTimelineRuler").addEventListener("pointerdown", beginNamedMotionCursorDrag);
    byId("namedMotionTimelinePlayheadHandle").addEventListener("pointerdown", beginNamedMotionCursorDrag);
    byId("namedMotionTimelineRuler").addEventListener("pointermove", moveNamedMotionCursorDrag);
    byId("namedMotionTimelineRuler").addEventListener("pointerup", (event) => finishNamedMotionCursorDrag(event));
    byId("namedMotionTimelineRuler").addEventListener("pointercancel", (event) => finishNamedMotionCursorDrag(event, true));
    byId("namedMotionTimelineRuler").addEventListener("lostpointercapture", (event) => finishNamedMotionCursorDrag(event, true));
    byId("namedMotionTimelineRuler").addEventListener("keydown", moveNamedMotionCursorWithKeyboard);
    byId("namedMotionList").addEventListener("pointerdown", beginNamedMotionClipDrag);
    byId("namedMotionList").addEventListener("pointermove", moveNamedMotionClipDrag);
    byId("namedMotionList").addEventListener("pointerup", (event) => finishNamedMotionClipDrag(event));
    byId("namedMotionList").addEventListener("pointercancel", (event) => finishNamedMotionClipDrag(event, true));
    byId("namedMotionList").addEventListener("lostpointercapture", (event) => finishNamedMotionClipDrag(event, true));
    byId("namedMotionList").addEventListener("click", handleNamedMotionTimelineClick);
    byId("namedMotionList").addEventListener("keydown", handleNamedMotionTimelineKeydown);
    byId("namedMotionTestButton").addEventListener("click", () => void testCurrentMotion());
    byId("namedActionTestButton").addEventListener("click", () => void testDraftDefinition());
    byId("namedActionStopButton").addEventListener("click", () => void stopTimelinePlayback("用户停止动作编辑测试"));

    byId("actionTimelineSearchInput").addEventListener("input", (event) => {
      actionSearchQuery = event.target.value;
      renderActionPalette({ placements: sequence.snapshot() });
    });
    byId("actionTimelineDefinitionPalette").addEventListener("click", selectPaletteDefinition);
    byId("actionTimelineDefinitionPalette").addEventListener("dblclick", addPaletteDefinitionOnDoubleClick);
    byId("actionTimelineDefinitionPalette").addEventListener("dragstart", beginPaletteDrag);
    byId("actionTimelineDefinitionPalette").addEventListener("dragend", () => finishPaletteDrag());
    byId("actionTimelineAddButton").addEventListener("click", addPlacementAtCursor);
    byId("actionTimelineAddTrackButton").addEventListener("click", addActionTrack);
    byId("actionTimelineSaveProjectButton").addEventListener("click", saveActionTimelineProject);
    byId("actionTimelineImportProjectButton").addEventListener("click", () => void importActionTimelineProject());
    byId("actionTimelineExportProjectButton").addEventListener("click", () => void exportActionTimelineProject());
    byId("actionTimelinePlayButton").addEventListener("click", () => void playActionTimeline());
    byId("actionTimelineStopButton").addEventListener("click", () => void stopTimelinePlayback("用户停止动作时间轴播放"));
    byId("actionTimelineDeleteButton").addEventListener("click", deleteSelectedPlacement);
    byId("actionTimelineClearButton").addEventListener("click", clearActionTimeline);
    byId("actionTimelineDurationInput").addEventListener("change", updateActionTimelineDuration);
    byId("actionTimelineSnapSelect").addEventListener("change", (event) => {
      const next = Number(event.target.value);
      if (!SNAP_OPTIONS.has(next)) return;
      snapMs = next;
      persistState();
      renderActionTimelineControls();
    });
    byId("actionTimelineZoomInput").addEventListener("input", (event) => {
      const next = Number(event.target.value);
      if (!Number.isSafeInteger(next) || next < 50 || next > 240) return;
      pixelsPerSecond = next;
      persistState();
      renderActionTimeline();
    });
    byId("actionTimelineRuler").addEventListener("pointerdown", beginCursorDrag);
    byId("actionTimelinePlayheadHandle").addEventListener("pointerdown", beginCursorDrag);
    byId("actionTimelineRuler").addEventListener("pointermove", moveCursorDrag);
    byId("actionTimelineRuler").addEventListener("pointerup", (event) => finishCursorDrag(event));
    byId("actionTimelineRuler").addEventListener("pointercancel", (event) => finishCursorDrag(event, true));
    byId("actionTimelineRuler").addEventListener("lostpointercapture", (event) => finishCursorDrag(event, true));
    byId("actionTimelineRuler").addEventListener("keydown", moveCursorWithKeyboard);
    byId("actionTimelineTracks").addEventListener("pointerdown", beginPlacementDrag);
    byId("actionTimelineTracks").addEventListener("pointermove", movePlacementDrag);
    byId("actionTimelineTracks").addEventListener("pointerup", (event) => finishPlacementDrag(event));
    byId("actionTimelineTracks").addEventListener("pointercancel", (event) => finishPlacementDrag(event, true));
    byId("actionTimelineTracks").addEventListener("lostpointercapture", (event) => finishPlacementDrag(event, true));
    byId("actionTimelineTracks").addEventListener("click", selectActionTimelineTarget);
    byId("actionTimelineTracks").addEventListener("change", renameActionTrack);
    byId("actionTimelineTracks").addEventListener("keydown", (event) => {
      const input = event.target.closest(".action-track-name-input");
      if (!input) return;
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        input.value = actionTrackById(input.dataset.trackId)?.name || input.value;
        input.blur();
      }
    });
    byId("actionTimelineScroller").addEventListener("dragover", movePaletteDrag);
    byId("actionTimelineScroller").addEventListener("drop", dropPaletteAction);
    byId("actionTimelineScroller").addEventListener("keydown", (event) => {
      if ((event.key === "Delete" || event.key === "Backspace") && selectedPlacementId && !interactionLocked()) {
        event.preventDefault();
        deleteSelectedPlacement();
      }
    });
  }

  root.LumNamedActions = Object.freeze({
    initialize,
    initEvents,
    loadStoredState,
    persistedStateFields,
    motorCatalogRemovalImpact,
    reconcileMotorCatalog,
    renderPage,
    renderAll,
    renderControls,
    preparePlayback,
    updatePlaybackCursor,
    renderPlaybackStatus,
    finishPlayback,
    renderPlaybackSurface,
    cancelInteractions,
    motionProfilesChanged,
    refreshMotionProfiles,
  });
}(window));
