import React, {
  Children,
  PureComponent,
  ReactElement,
  SVGAttributes,
  SVGProps,
  TouchEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { scalePoint, ScalePoint } from 'victory-vendor/d3-scale';
import range from 'lodash/range';
import { Layer } from '../container/Layer';
import { Text } from '../component/Text';
import { getValueByDataKey } from '../util/ChartUtils';
import { isNumber } from '../util/DataUtils';
import { generatePrefixStyle } from '../util/CssPrefixUtils';
import { DataKey, Padding } from '../util/types';
import { filterProps } from '../util/ReactUtils';
import { useUpdateId } from '../context/chartLayoutContext';
import { useChartData, useDataIndex } from '../context/chartDataContext';
import { BrushStartEndIndex, OnBrushUpdate, BrushUpdateDispatchContext } from '../context/brushUpdateContext';
import { useAppDispatch, useAppSelector } from '../state/hooks';
import { setDataStartEndIndexes } from '../state/chartDataSlice';
import { BrushSettings, setBrushSettings } from '../state/brushSlice';
import { PanoramaContextProvider } from '../context/PanoramaContext';
import { selectBrushDimensions } from '../state/selectors/brushSelectors';
import { useBrushChartSynchronisation } from '../synchronisation/useChartSynchronisation';

type BrushTravellerType = ReactElement<SVGElement> | ((props: TravellerProps) => ReactElement<SVGElement>);

// Why is this tickFormatter different from the other TickFormatters? This one allows to return numbers too for some reason.
type BrushTickFormatter = (value: any, index: number) => number | string;

interface BrushProps {
  x?: number;
  y?: number;
  width?: number;
  className?: string;

  ariaLabel?: string;

  height: number;
  travellerWidth?: number;
  traveller?: BrushTravellerType;
  gap?: number;
  padding?: Padding;

  dataKey?: DataKey<any>;
  startIndex?: number;
  endIndex?: number;
  tickFormatter?: BrushTickFormatter;

  children?: ReactElement;

  onChange?: OnBrushUpdate;
  onDragEnd?: OnBrushUpdate;
  leaveTimeOut?: number;
  alwaysShowText?: boolean;
}

export type Props = Omit<SVGProps<SVGElement>, 'onChange'> & BrushProps;

type PropertiesFromContext = {
  x: number;
  y: number;
  width: number;
  data: any[];
  startIndex: number;
  endIndex: number;
  updateId: string;
  onChange: OnBrushUpdate;
};

type BrushTravellerId = 'startX' | 'endX';

function DefaultTraveller(props: TravellerProps) {
  const { x, y, width, height, stroke } = props;
  const lineY = Math.floor(y + height / 2) - 1;

  return (
    <>
      <rect x={x} y={y} width={width} height={height} fill={stroke} stroke="none" />
      <line x1={x + 1} y1={lineY} x2={x + width - 1} y2={lineY} fill="none" stroke="#fff" />
      <line x1={x + 1} y1={lineY + 2} x2={x + width - 1} y2={lineY + 2} fill="none" stroke="#fff" />
    </>
  );
}

function Traveller(props: { travellerType: BrushTravellerType; travellerProps: TravellerProps }) {
  const { travellerProps, travellerType } = props;

  if (React.isValidElement(travellerType)) {
    // @ts-expect-error element cloning disagrees with the types (and it should)
    return React.cloneElement(travellerType, travellerProps);
  }
  if (typeof travellerType === 'function') {
    return travellerType(travellerProps);
  }
  return <DefaultTraveller {...travellerProps} />;
}

function TravellerLayer({
  otherProps,
  travellerX,
  id,
  onMouseEnter,
  onMouseLeave,
  onMouseDown,
  onTouchStart,
  onTravellerMoveKeyboard,
  onFocus,
  onBlur,
}: {
  id: BrushTravellerId;
  travellerX: number;
  otherProps: BrushWithStateProps;
  onMouseEnter: (e: MouseOrTouchEvent) => void;
  onMouseLeave: (e: MouseOrTouchEvent) => void;
  onMouseDown: (e: MouseOrTouchEvent) => void;
  onTouchStart: (e: MouseOrTouchEvent) => void;
  onTravellerMoveKeyboard: (direction: -1 | 1, travellerId: BrushTravellerId) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const { y, x: xFromProps, travellerWidth, height, traveller, ariaLabel, data, startIndex, endIndex } = otherProps;
  const x = Math.max(travellerX ?? 0, xFromProps);
  const travellerProps: TravellerProps = {
    ...filterProps(otherProps, false),
    x,
    y,
    width: travellerWidth,
    height,
  };

  const ariaLabelBrush = ariaLabel || `Min value: ${data[startIndex]?.name}, Max value: ${data[endIndex]?.name}`;

  return (
    <Layer
      tabIndex={0}
      role="slider"
      aria-label={ariaLabelBrush}
      aria-valuenow={travellerX}
      className="recharts-brush-traveller"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onTravellerMoveKeyboard(e.key === 'ArrowRight' ? 1 : -1, id);
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      style={{ cursor: 'col-resize' }}
    >
      <Traveller travellerType={traveller} travellerProps={travellerProps} />
    </Layer>
  );
}

type TextOfTickProps = {
  index: number;
  data: any[];
  dataKey: DataKey<any>;
  tickFormatter: BrushTickFormatter;
};

/*
 * This one cannot be a React Component because React is not happy with it returning only string | number.
 * React wants a full React.JSX.Element but that is not compatible with Text component.
 */
function getTextOfTick(props: TextOfTickProps): number | string {
  const { index, data, tickFormatter, dataKey } = props;
  const text = getValueByDataKey(data[index], dataKey, index);

  // @ts-expect-error getValueByDataKey does not validate the output type
  return typeof tickFormatter === 'function' ? tickFormatter(text, index) : text;
}

function getIndexInRange(valueRange: number[], x: number) {
  const len = valueRange.length;
  let start = 0;
  let end = len - 1;

  while (end - start > 1) {
    const middle = Math.floor((start + end) / 2);

    if (valueRange[middle] > x) {
      end = middle;
    } else {
      start = middle;
    }
  }

  return x >= valueRange[end] ? end : start;
}

function getIndex({
  startX,
  endX,
  scaleValues,
  gap,
  data,
}: {
  startX: number;
  endX: number;
  scaleValues: number[];
  gap: number;
  data: any[];
}): BrushStartEndIndex {
  const lastIndex = data.length - 1;
  const min = Math.min(startX, endX);
  const max = Math.max(startX, endX);
  const minIndex = getIndexInRange(scaleValues, min);
  const maxIndex = getIndexInRange(scaleValues, max);
  return {
    startIndex: minIndex - (minIndex % gap),
    endIndex: maxIndex === lastIndex ? lastIndex : maxIndex - (maxIndex % gap),
  };
}

function Background({
  x,
  y,
  width,
  height,
  fill,
  stroke,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
}) {
  return <rect stroke={stroke} fill={fill} x={x} y={y} width={width} height={height} />;
}

function BrushText({
  startIndex,
  endIndex,
  y,
  height,
  travellerWidth,
  stroke,
  tickFormatter,
  dataKey,
  data,
  startX,
  endX,
}: {
  startIndex: number;
  endIndex: number;
  y: number;
  height: number;
  travellerWidth: number;
  stroke: string;
  tickFormatter: BrushTickFormatter;
  dataKey: DataKey<any>;
  data: any[];
  startX: number;
  endX: number;
}) {
  const offset = 5;
  const attrs = {
    pointerEvents: 'none',
    fill: stroke,
  };

  return (
    <Layer className="recharts-brush-texts">
      <Text textAnchor="end" verticalAnchor="middle" x={Math.min(startX, endX) - offset} y={y + height / 2} {...attrs}>
        {getTextOfTick({ index: startIndex, tickFormatter, dataKey, data })}
      </Text>
      <Text
        textAnchor="start"
        verticalAnchor="middle"
        x={Math.max(startX, endX) + travellerWidth + offset}
        y={y + height / 2}
        {...attrs}
      >
        {getTextOfTick({ index: endIndex, tickFormatter, dataKey, data })}
      </Text>
    </Layer>
  );
}

function Slide({
  y,
  height,
  stroke,
  travellerWidth,
  startX,
  endX,
  onMouseEnter,
  onMouseLeave,
  onMouseDown,
  onTouchStart,
}: {
  y: number;
  height: number;
  stroke: string;
  travellerWidth: number;
  startX: number;
  endX: number;
  onMouseEnter: (e: MouseOrTouchEvent) => void;
  onMouseLeave: (e: MouseOrTouchEvent) => void;
  onMouseDown: (e: MouseOrTouchEvent) => void;
  onTouchStart: (e: MouseOrTouchEvent) => void;
}) {
  const x = Math.min(startX, endX) + travellerWidth;
  const width = Math.max(Math.abs(endX - startX) - travellerWidth, 0);

  return (
    <rect
      className="recharts-brush-slide"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      style={{ cursor: 'move' }}
      stroke="none"
      fill={stroke}
      fillOpacity={0.2}
      x={x}
      y={y}
      width={width}
      height={height}
    />
  );
}

function Panorama({
  x,
  y,
  width,
  height,
  data,
  children,
  padding,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  data: any[];
  children: ReactElement;
  padding: Padding;
}) {
  const isPanoramic = React.Children.count(children) === 1;
  if (!isPanoramic) {
    return null;
  }
  const chartElement = Children.only(children);

  if (!chartElement) {
    return null;
  }

  return React.cloneElement(chartElement, {
    x,
    y,
    width,
    height,
    margin: padding,
    compact: true,
    data,
  });
}

type TravellerProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  stroke?: SVGAttributes<SVGElement>['stroke'];
};

type CreateScaleReturn = {
  startX?: number;
  endX?: number;
  scale?: ScalePoint<number> | null;
  scaleValues?: number[];
};

const createScale = ({
  data,
  startIndex,
  endIndex,
  x,
  width,
  travellerWidth,
}: {
  data?: any[];
  startIndex?: number;
  endIndex?: number;
  x?: number;
  width?: number;
  travellerWidth?: number;
}): CreateScaleReturn => {
  if (!data || !data.length) {
    return {};
  }

  const len = data.length;
  const scale = scalePoint<number>()
    .domain(range(0, len))
    .range([x, x + width - travellerWidth]);
  const scaleValues = scale.domain().map(entry => scale(entry));

  return {
    startX: scale(startIndex),
    endX: scale(endIndex),
    scale,
    scaleValues,
  };
};

const isTouch = (e: TouchEvent<SVGElement> | React.MouseEvent<SVGElement>): e is TouchEvent<SVGElement> =>
  (e as TouchEvent<SVGElement>).changedTouches && !!(e as TouchEvent<SVGElement>).changedTouches.length;

type MouseOrTouchEvent = React.MouseEvent<SVGGElement> | TouchEvent<SVGGElement>;

type BrushWithStateProps = Props & PropertiesFromContext;

const RedoBrush = (props: BrushWithStateProps): React.ReactElement | null => {
  const { x, width, travellerWidth, onChange, gap, data, startIndex, endIndex } = props;
  const [isTravellerMoving, setIsTravellerMoving] = useState<boolean>(false);
  const [isTravellerFocused, setIsTravellerFocused] = useState<boolean>(false);
  const [isSlideMoving, setIsSlideMoving] = useState<boolean>(false);
  const [isTextActive, setIsTextActive] = useState<boolean>(false);
  const [movingTravellerId, setMovingTravellerId] = useState<BrushTravellerId | undefined>(undefined);
  const [brushMoveStartX, setBrushMoveStartX] = useState<number | undefined>(undefined);

  const [travellerPositions, setTravellerPositions] = useState<Record<BrushTravellerId, number>>(undefined);
  const { startX, endX } = travellerPositions ?? {};
  const [slideMoveStartX, setSlideMoveStartX] = useState<number | undefined>(undefined);

  const leaveTimerRef = useRef(null);

  // scaleValues are a list of coordinates. For example: [65, 250, 435, 620, 805, 990].
  const { scale, scaleValues } =
    data && data.length ? createScale({ data, width, x, travellerWidth, startIndex, endIndex }) : { scale: null };

  if (scale && !travellerPositions) {
    setTravellerPositions({ startX: scale(startIndex), endX: scale(endIndex) });
  }

  const handleTravellerMove = useCallback(
    (e: React.Touch | React.MouseEvent<SVGGElement> | MouseEvent) => {
      const prevValue = travellerPositions[movingTravellerId];
      // console.log('prev', prevValue, movingTravellerId, travellerPositions);

      const params: { data: any[]; gap: number; scaleValues: number[]; startX?: number; endX?: number } = {
        data,
        gap,
        scaleValues,
      };

      let delta = e.pageX - brushMoveStartX;
      if (delta > 0) {
        delta = Math.min(delta, x + width - travellerWidth - prevValue);
      } else if (delta < 0) {
        delta = Math.max(delta, x - prevValue);
      }

      params[movingTravellerId] = prevValue + delta;

      const newIndex = getIndex({ ...params, startX, endX });
      const { startIndex: newStart, endIndex: newEnd } = newIndex;
      const isFullGap = () => {
        const lastIndex = data.length - 1;
        if (
          (movingTravellerId === 'startX' && (endX > startX ? newStart % gap === 0 : newEnd % gap === 0)) ||
          (endX < startX && newEnd === lastIndex) ||
          (movingTravellerId === 'endX' && (endX > startX ? newEnd % gap === 0 : newStart % gap === 0)) ||
          (endX > startX && newEnd === lastIndex)
        ) {
          return true;
        }
        return false;
      };

      setTravellerPositions(prev => ({ ...prev, [movingTravellerId]: prev[movingTravellerId] + delta }));
      setBrushMoveStartX(e.pageX);
      if (onChange) {
        if (isFullGap()) {
          onChange(newIndex);
        }
      }
    },
    [
      brushMoveStartX,
      data,
      endX,
      gap,
      movingTravellerId,
      onChange,
      scaleValues,
      startX,
      travellerPositions,
      travellerWidth,
      width,
      x,
    ],
  );

  const handleSlideDrag = useCallback(
    (e: React.Touch | React.MouseEvent<SVGGElement> | MouseEvent) => {
      let delta = e.pageX - slideMoveStartX;

      if (delta > 0) {
        delta = Math.min(delta, x + width - travellerWidth - endX, x + width - travellerWidth - startX);
      } else if (delta < 0) {
        delta = Math.max(delta, x - startX, x - endX);
      }
      const newIndex = getIndex({
        startX: startX + delta,
        endX: endX + delta,
        data,
        gap,
        scaleValues,
      });

      if ((newIndex.startIndex !== startIndex || newIndex.endIndex !== endIndex) && onChange) {
        onChange(newIndex);
      }

      setTravellerPositions(prev => ({ startX: prev.startX + delta, endX: prev.endX + delta }));
      setSlideMoveStartX(e.pageX);
    },
    [data, endIndex, endX, gap, onChange, scaleValues, slideMoveStartX, startIndex, startX, travellerWidth, width, x],
  );

  const handleDrag = useCallback(
    (e: React.Touch | React.MouseEvent<SVGGElement> | MouseEvent) => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }

      if (isTravellerMoving) {
        handleTravellerMove(e);
      } else if (isSlideMoving) {
        handleSlideDrag(e);
      }
    },
    [handleSlideDrag, handleTravellerMove, isSlideMoving, isTravellerMoving],
  );

  const handleDragEnd = useCallback(() => {
    setIsTravellerMoving(false);
    setIsSlideMoving(false);
    const { onDragEnd } = props;
    onDragEnd?.({
      endIndex,
      startIndex,
    });

    window.removeEventListener('mouseup', this, true);
    window.removeEventListener('touchend', this, true);
    window.removeEventListener('mousemove', handleDrag, true);
  }, [endIndex, handleDrag, props, startIndex]);

  const handleTouchMove = (e: TouchEvent<SVGGElement>) => {
    if (e.changedTouches != null && e.changedTouches.length > 0) {
      handleDrag(e.changedTouches[0]);
    }
  };

  const handleEnterSlideOrTraveller = () => {
    setIsTextActive(true);
  };

  const handleLeaveSlideOrTraveller = () => {
    setIsTextActive(false);
  };

  useEffect(() => {
    return () => {
      console.log('leave timer', leaveTimerRef.current);
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }

      window.removeEventListener('mouseup', handleDragEnd, true);
      window.removeEventListener('touchend', handleDragEnd, true);
      window.removeEventListener('mousemove', handleDrag, true);
    };
  }, [handleDrag, handleDragEnd]);

  const handleLeaveWrapper = () => {
    if (isTravellerMoving || isSlideMoving) {
      leaveTimerRef.current = window.setTimeout(handleDragEnd, props.leaveTimeOut);
      console.log('leaving', isTravellerMoving, isSlideMoving);
    }
  };

  const handleTravellerDragStart = (id: BrushTravellerId, e: MouseOrTouchEvent) => {
    const event = isTouch(e) ? e.changedTouches[0] : e;

    setIsSlideMoving(false);
    setIsTravellerMoving(true);
    setMovingTravellerId(id);
    setBrushMoveStartX(event.pageX);
  };

  useEffect(() => {
    const attachDragEndListener = () => {
      window.addEventListener('mouseup', handleDragEnd, true);
      window.addEventListener('touchend', handleDragEnd, true);
      window.addEventListener('mousemove', handleDrag, true);
    };

    if (isSlideMoving || isTravellerMoving) attachDragEndListener();

    return () => {
      window.removeEventListener('mouseup', handleDragEnd, true);
      window.removeEventListener('touchend', handleDragEnd, true);
      window.removeEventListener('mousemove', handleDrag, true);
    };
  }, [handleDrag, handleDragEnd, isSlideMoving, isTravellerMoving]);

  const handleSlideDragStart = (e: MouseOrTouchEvent) => {
    const event = isTouch(e) ? e.changedTouches[0] : e;

    setIsTravellerMoving(false);
    setIsSlideMoving(true);
    setSlideMoveStartX(event.pageX);
  };

  const handleTravellerMoveKeyboard = (direction: 1 | -1, id: BrushTravellerId) => {
    // currentScaleValue refers to which coordinate the current traveller should be placed at.
    const currentScaleValue = travellerPositions[id];

    const currentIndex = scaleValues.indexOf(currentScaleValue);
    if (currentIndex === -1) {
      return;
    }

    const newIndex = currentIndex + direction;
    if (newIndex === -1 || newIndex >= scaleValues.length) {
      return;
    }

    const newScaleValue = scaleValues[newIndex];

    // Prevent travellers from being on top of each other or overlapping
    if ((id === 'startX' && newScaleValue >= endX) || (id === 'endX' && newScaleValue <= startX)) {
      return;
    }

    setTravellerPositions(prev => ({
      ...prev,
      [id]: newScaleValue,
    }));

    onChange(
      getIndex({
        startX,
        endX,
        data,
        gap,
        scaleValues,
      }),
    );
  };

  const { height, y } = props;

  if (
    !data ||
    !data.length ||
    !isNumber(x) ||
    !isNumber(y) ||
    !isNumber(width) ||
    !isNumber(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const { className, alwaysShowText, fill, stroke, children, padding, tickFormatter, dataKey } = props;

  const layerClass = clsx('recharts-brush', className);
  const style = generatePrefixStyle('userSelect', 'none');
  console.log(leaveTimerRef);

  return (
    <Layer className={layerClass} onMouseLeave={handleLeaveWrapper} onTouchMove={handleTouchMove} style={style}>
      <Background x={x} y={y} width={width} height={height} fill={fill} stroke={stroke} />
      <PanoramaContextProvider>
        <Panorama x={x} y={y} width={width} height={height} data={data} padding={padding}>
          {children}
        </Panorama>
      </PanoramaContextProvider>
      <Slide
        y={y}
        height={height}
        stroke={stroke}
        travellerWidth={travellerWidth}
        startX={startX}
        endX={endX}
        onMouseEnter={handleEnterSlideOrTraveller}
        onMouseLeave={handleLeaveSlideOrTraveller}
        onMouseDown={handleSlideDragStart}
        onTouchStart={handleSlideDragStart}
      />
      <TravellerLayer
        travellerX={startX}
        id="startX"
        otherProps={props}
        onMouseEnter={handleEnterSlideOrTraveller}
        onMouseLeave={handleLeaveSlideOrTraveller}
        onMouseDown={e => handleTravellerDragStart('startX', e)}
        onTouchStart={e => handleTravellerDragStart('startX', e)}
        onTravellerMoveKeyboard={handleTravellerMoveKeyboard}
        onFocus={() => {
          setIsTravellerFocused(true);
        }}
        onBlur={() => {
          setIsTravellerFocused(false);
        }}
      />
      <TravellerLayer
        travellerX={endX}
        id="endX"
        otherProps={props}
        onMouseEnter={handleEnterSlideOrTraveller}
        onMouseLeave={handleLeaveSlideOrTraveller}
        onMouseDown={e => handleTravellerDragStart('endX', e)}
        onTouchStart={e => handleTravellerDragStart('endX', e)}
        onTravellerMoveKeyboard={handleTravellerMoveKeyboard}
        onFocus={() => {
          setIsTravellerFocused(true);
        }}
        onBlur={() => {
          setIsTravellerFocused(false);
        }}
      />
      {(isTextActive || isSlideMoving || isTravellerMoving || isTravellerFocused || alwaysShowText) && (
        <BrushText
          startIndex={startIndex}
          endIndex={endIndex}
          y={y}
          height={height}
          travellerWidth={travellerWidth}
          stroke={stroke}
          tickFormatter={tickFormatter}
          dataKey={dataKey}
          data={data}
          startX={startX}
          endX={endX}
        />
      )}
    </Layer>
  );
};

function BrushInternal(props: Props) {
  const dispatch = useAppDispatch();
  const chartData = useChartData();
  const { startIndex, endIndex } = useDataIndex();
  const updateId = useUpdateId();
  const onChangeFromContext = useContext(BrushUpdateDispatchContext);
  const onChangeFromProps = props.onChange;
  const { startIndex: startIndexFromProps, endIndex: endIndexFromProps } = props;

  useEffect(() => {
    // start and end index can be controlled from props, and we need them to stay up-to-date in the Redux state too
    dispatch(setDataStartEndIndexes({ startIndex: startIndexFromProps, endIndex: endIndexFromProps }));
  }, [dispatch, endIndexFromProps, startIndexFromProps]);

  useBrushChartSynchronisation();

  const onChange = useCallback(
    (nextState: BrushStartEndIndex) => {
      if (nextState.startIndex !== startIndex || nextState.endIndex !== endIndex) {
        onChangeFromContext?.(nextState);
        onChangeFromProps?.(nextState);
        dispatch(setDataStartEndIndexes(nextState));
      }
    },
    [onChangeFromProps, onChangeFromContext, dispatch, startIndex, endIndex],
  );

  const { x, y, width } = useAppSelector(selectBrushDimensions);
  const contextProperties: PropertiesFromContext = {
    data: chartData,
    x,
    y,
    width,
    startIndex,
    endIndex,
    updateId,
    onChange,
  };
  const { ref, ...allOtherProps } = props;
  return <RedoBrush {...allOtherProps} {...contextProperties} />;
}

function BrushSettingsDispatcher(props: BrushSettings): null {
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch(setBrushSettings(props));
    return () => {
      dispatch(setBrushSettings(null));
    };
  }, [dispatch, props]);
  return null;
}

export class Brush extends PureComponent<Props> {
  static displayName = 'Brush';

  static defaultProps = {
    height: 40,
    travellerWidth: 5,
    gap: 1,
    fill: '#fff',
    stroke: '#666',
    padding: { top: 1, right: 1, bottom: 1, left: 1 },
    leaveTimeOut: 1000,
    alwaysShowText: false,
  };

  render() {
    return (
      <>
        <BrushSettingsDispatcher
          height={this.props.height}
          x={this.props.x}
          y={this.props.y}
          width={this.props.width}
          padding={this.props.padding}
        />
        <BrushInternal {...this.props} />
      </>
    );
  }
}
