(function initializeMediaContract(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.DoudianMediaContract = api;
  }
})(globalThis, function createMediaContractApi() {
  "use strict";

  const OPTIONAL_MEDIA_CAPACITIES = Object.freeze({
    ratio34: 5,
    video: 1,
    whiteBackground: 1
  });
  const DETAIL_IMAGE_CAPACITY = 50;

  function assertOptionalMediaState(state) {
    const expectedCapacity = OPTIONAL_MEDIA_CAPACITIES[state?.kind];
    const valid =
      expectedCapacity !== undefined &&
      state?.capacity === expectedCapacity &&
      Number.isInteger(state?.previewCount) &&
      state.previewCount >= 0 &&
      state.previewCount <= expectedCapacity;

    if (!valid) {
      const error = new Error("Optional media field state is invalid");
      error.code = "OPTIONAL_MEDIA_STATE_INVALID";
      error.evidence = {
        ...state,
        expectedCapacity: expectedCapacity ?? null
      };
      throw error;
    }

    return {
      kind: state.kind,
      capacity: expectedCapacity,
      previewCount: state.previewCount
    };
  }

  function assertOptionalMediaTransition(before, after, fileIndex) {
    const beforeState = assertOptionalMediaState(before);
    const afterState = assertOptionalMediaState(after);
    const valid =
      beforeState.kind === afterState.kind &&
      Number.isInteger(fileIndex) &&
      fileIndex >= 0 &&
      fileIndex < beforeState.capacity &&
      beforeState.previewCount === fileIndex &&
      afterState.previewCount === fileIndex + 1;

    if (!valid) {
      const error = new Error(
        "Optional media preview count did not advance sequentially"
      );
      error.code = "OPTIONAL_MEDIA_TRANSITION_MISMATCH";
      error.evidence = {
        kind: beforeState.kind,
        afterKind: afterState.kind,
        capacity: beforeState.capacity,
        fileIndex,
        expectedBefore: fileIndex,
        expectedAfter: Number.isInteger(fileIndex) ? fileIndex + 1 : null,
        before: beforeState.previewCount,
        after: afterState.previewCount
      };
      throw error;
    }

    return {
      kind: beforeState.kind,
      capacity: beforeState.capacity,
      fileIndex,
      before: beforeState.previewCount,
      after: afterState.previewCount
    };
  }

  function assertAuxiliarySlotState(state) {
    const controls = Array.isArray(state?.controls) ? state.controls : [];
    const emptySlotCount = state?.emptySlotCount;
    const previewCount = state?.previewCount;
    const expectedPreviewCount = 5 - emptySlotCount;
    const valid =
      state?.candidateUlCount === 1 &&
      state?.imageInputCount === 5 &&
      state?.controlCount === 5 &&
      state?.uniqueControlCount === 5 &&
      state?.visibleControlCount === 5 &&
      state?.mappedInputControlCount === 5 &&
      Number.isInteger(emptySlotCount) &&
      emptySlotCount >= 0 &&
      emptySlotCount <= 4 &&
      previewCount === expectedPreviewCount &&
      state?.globalPreviewCount === previewCount &&
      controls.length === 5 &&
      controls[0]?.kind === "preview" &&
      controls.every((control, index) => {
        if (index < previewCount) {
          return (
            control?.kind === "preview" &&
            control?.imageInputCount === 1 &&
            control?.multiple === false &&
            control?.remoteResourceCount > 0
          );
        }
        return (
          control?.kind === "upload" &&
          control?.imageInputCount === 1 &&
          control?.multiple === true &&
          control?.exactAuxiliaryText === true
        );
      });

    if (!valid) {
      const error = new Error("Auxiliary media slot state is invalid");
      error.code = "AUXILIARY_MEDIA_SCOPE_UNRECOGNIZED";
      error.evidence = {
        ...state,
        expectedPreviewCount,
        controls
      };
      throw error;
    }

    return {
      emptySlotCount,
      previewCount,
      targetControlIndex: previewCount
    };
  }

  function assertAuxiliaryTransition(before, after, fileIndex) {
    const expectedBefore = 4 - fileIndex;
    const expectedAfter = expectedBefore - 1;
    if (
      !Number.isInteger(fileIndex) ||
      fileIndex < 0 ||
      fileIndex > 3 ||
      before !== expectedBefore ||
      after !== expectedAfter
    ) {
      const error = new Error("辅助图空位未按计划减少一个");
      error.code = "AUXILIARY_SLOT_TRANSITION_MISMATCH";
      error.evidence = {
        fileIndex,
        expectedBefore,
        expectedAfter,
        before,
        after
      };
      throw error;
    }
    return { fileIndex, before, after };
  }

  function initialDetailAction(count) {
    if (count === 0) return "ready";
    if (count === 1) return "remove_default";
    const error = new Error("商品详情初始图片数量不安全");
    error.code = "DETAIL_INITIAL_COUNT_AMBIGUOUS";
    error.evidence = { count, allowed: [0, 1] };
    throw error;
  }

  function assertDefaultDetailRemoved(before, after) {
    if (before !== 1 || after !== 0) {
      const error = new Error("默认商品详情图片删除后计数未归零");
      error.code = "DETAIL_DEFAULT_REMOVAL_MISMATCH";
      error.evidence = { before, after };
      throw error;
    }
    return { before, after };
  }

  function assertDetailUploadTransition(before, after, fileIndex) {
    if (
      !Number.isInteger(fileIndex) ||
      fileIndex < 0 ||
      fileIndex >= DETAIL_IMAGE_CAPACITY ||
      before !== fileIndex ||
      after !== fileIndex + 1
    ) {
      const error = new Error("商品详情图片计数未按计划增加一个");
      error.code = "DETAIL_UPLOAD_COUNT_MISMATCH";
      error.evidence = {
        fileIndex,
        capacity: DETAIL_IMAGE_CAPACITY,
        expectedBefore: fileIndex,
        expectedAfter: fileIndex + 1,
        before,
        after
      };
      throw error;
    }
    return { fileIndex, before, after };
  }

  return Object.freeze({
    OPTIONAL_MEDIA_CAPACITIES,
    DETAIL_IMAGE_CAPACITY,
    assertAuxiliarySlotState,
    assertAuxiliaryTransition,
    assertDefaultDetailRemoved,
    assertDetailUploadTransition,
    assertOptionalMediaState,
    assertOptionalMediaTransition,
    initialDetailAction
  });
});
